/**
 * Build-time Stent transform for a Node-capable bundler.
 *
 * `.ts`/`.tsx` source is transpiled with `ts.transpileModule` (including JSX)
 * before Orchestrion parses it; other syntax must be compiled by the caller.
 * Matcher selection is shared with Node, while module type detection here is
 * extension-based. This internal module backs `@oh-my-dsh/stent/browser`.
 *
 * @module @oh-my-dsh/stent/transform/browser
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import ts from 'typescript'

import { expandPatchStub, type StentInstrumentationConfig } from './config.ts'
import { detectModuleType } from './identity.ts'
import {
  createStentMatcher,
  getStentTransformer,
  transformStentSource,
} from './matcher.ts'
import type { StentBindingReport, StentPatchStub } from './types.ts'

/**
 * Transpile TypeScript/JSX so the JavaScript AST transformer can parse it. This
 * performs emit only, not type checking; any transformer map describes emitted
 * JavaScript and is not chained back to the original TypeScript source.
 *
 * @param code - TypeScript or TSX source.
 * @param fileName - Filename used for TypeScript emit context.
 * @returns Emitted JavaScript source.
 */
function stripTypes(code: string, fileName: string): string {
  const output = ts.transpileModule(code, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      // JSX must be emitted as calls (the parser cannot read JSX syntax). The
      // automatic runtime keeps the output self-contained: sources using the
      // modern transform (no React import) get a `react/jsx-runtime` import
      // instead of referencing an undefined `React`, while classic-runtime
      // sources keep their explicit `React.createElement` calls and React
      // import untouched.
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  return output.outputText
}

/** Module identity the matcher needs for one module id. */
interface ModuleIdentity {
  /** Npm package name. */
  name: string
  /** Installed or declared package version. */
  version: string
  /** File path relative to the package root. */
  path: string
}

/** Map a bundler module id to its package identity; `undefined` skips it. */
type IdentityResolver = (id: string) => ModuleIdentity | undefined

/** Options for {@link repoSourceResolver}. */
interface RepoSourceResolverOptions {
  /** Npm package name of the built client plugin. */
  packageName: string
  /** Source root used for exact prefix matching; normally an absolute path. */
  packageRoot: string
  /** Package version used for `versionRange` matching; not put in bridge calls. */
  version: string
}

/**
 * Resolve repository source modules: any id under `packageRoot` maps to the
 * given package name and version. Matching is a raw `packageRoot + '/'` prefix;
 * virtual ids and query-suffixed ids are not normalized by this resolver. This
 * is the resolver client plugin builds use for repository source layouts.
 *
 * @param options - Package identity and source-root options.
 * @returns An identity resolver for that package's sources.
 */
function repoSourceResolver({
  packageName,
  packageRoot,
  version,
}: RepoSourceResolverOptions): IdentityResolver {
  const root = packageRoot.endsWith('/') ? packageRoot : `${packageRoot}/`
  return (id) => {
    if (!id.startsWith(root)) {
      return undefined
    }
    return {
      name: packageName,
      version,
      path: relative(packageRoot, id).replaceAll('\\', '/'),
    }
  }
}

/** A transformed module: rewritten source plus an optional source map. */
interface TransformOutput {
  /** Rewritten source code. */
  code: string
  /** Source map when the underlying transformer produced one. */
  map?: string
  /** Per-patch binding reports for this module, when anything was rewritten. */
  bindings?: StentBindingReport[]
}

/** A bundler transform for one set of Stent patches. */
type BrowserTransform = (code: string, id: string) => TransformOutput | null

/** Options for {@link createBrowserTransform}. */
interface BrowserTransformOptions {
  /** Static patch stubs to apply during the bundle build. */
  patches: readonly StentPatchStub[]
  /** Resolver mapping a bundler module id to its package identity. */
  resolve: IdentityResolver
}

/** Options for {@link createWatchedBrowserTransform}. */
interface WatchedBrowserTransformOptions {
  /** Patch-stub JSON path to read and register; relative paths are accepted. */
  patchesPath: string
  /** Resolver mapping a bundler module id to its package identity. */
  resolve: IdentityResolver
}

/**
 * Build a transform from already-expanded internal instrumentation configs.
 * Node's loader-thread entry uses this boundary after reviving its wire data;
 * browser consumers should use {@link createBrowserTransform} with patch
 * stubs.
 *
 * @param instrumentations - Already-expanded internal instrumentation configs.
 * @param resolve - Module identity resolver for the build's source layout.
 * @returns A transform function `(code, id) => output | null`; an output may
 *   omit `bindings` when no selected node was rewritten.
 * @throws When the returned transform is called and the selected source cannot
 *   be parsed or its injection fails.
 */
function createInstrumentedTransform(
  instrumentations: readonly StentInstrumentationConfig[],
  resolve: IdentityResolver,
): BrowserTransform {
  // Per-call pending counts: the transform function below runs once per
  // module, so counts accumulated during one call belong to that module.
  const pending = new Map<string, number>()
  const matcher = createStentMatcher(instrumentations, (patchId) => {
    pending.set(patchId, (pending.get(patchId) ?? 0) + 1)
  })

  return (code, id) => {
    const identity = resolve(id)
    if (!identity) {
      return null
    }
    const transformer = getStentTransformer(
      matcher,
      identity.name,
      identity.version,
      identity.path,
    )
    if (!transformer) {
      return null
    }
    // TypeScript sources are stripped to plain JavaScript first; the source
    // map is intentionally not chained through the strip step.
    const source = /\.tsx?$/.test(id) ? stripTypes(code, id) : code
    pending.clear()
    const result = transformStentSource(
      transformer,
      source,
      detectModuleType(id),
    )
    const output: TransformOutput =
      result.map === undefined
        ? { code: result.code }
        : { code: result.code, map: result.map }
    if (pending.size > 0) {
      output.bindings = [...pending].map(([patchId, nodes]) => ({
        patchId,
        module: identity.name,
        file: identity.path,
        nodes,
      }))
    }
    return output
  }
}

/**
 * Build a browser bundle transform from public Stent patch stubs. Static fields
 * are expanded eagerly; `required` is validated on the public stub, then
 * dropped from the internal instrumentation and is not enforced by this browser
 * factory.
 *
 * @param options - Patch stubs and the build's identity resolver.
 * @returns A transform function `(code, id) => output | null`.
 * @throws If static metadata or a name/query selector cannot be expanded.
 */
function createBrowserTransform({
  patches,
  resolve,
}: BrowserTransformOptions): BrowserTransform {
  return createInstrumentedTransform(patches.flatMap(expandPatchStub), resolve)
}

/**
 * A browser transform that also receives the bundler's watch-file registration
 * hook (the third argument `clientBundle`'s source-transform plugin forwards),
 * so a file-backed patch set joins the watch graph.
 */
type WatchedBrowserTransform = (
  code: string,
  id: string,
  addWatchFile?: (file: string) => void,
) => TransformOutput | null

/**
 * Parse the watched patches file's outer JSON shape. The result is checked for
 * an array and an object `target`; full static/query validation is deferred to
 * `createBrowserTransform` when the file content causes a matcher rebuild. JSON
 * cannot express a `RegExp` `filePath`; serialized path values must therefore
 * be strings, while `filePaths` remains supported as a string array.
 *
 * @param content - Raw file content.
 * @param patchesPath - File path, used in error messages.
 * @returns Patch stubs with the minimally validated outer shape.
 * @throws If JSON is invalid, the root is not an array, or an entry lacks an
 *   object target.
 */
function parsePatchesFile(
  content: string,
  patchesPath: string,
): StentPatchStub[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(
      `stent: cannot parse watched patches file ${patchesPath} as JSON`,
      { cause: error },
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `stent: watched patches file ${patchesPath} must hold a JSON array of patch stubs`,
    )
  }
  return parsed.map((entry: unknown, index) => {
    const target: unknown =
      typeof entry === 'object' && entry !== null
        ? (entry as { target?: unknown }).target
        : undefined
    if (
      typeof entry !== 'object'
      || entry === null
      || typeof target !== 'object'
      || target === null
    ) {
      throw new Error(
        `stent: watched patches file ${patchesPath} entry ${index} must be a patch stub object with a target`,
      )
    }
    // createBrowserTransform validates the remaining static fields and expands
    // the query when this entry is rebuilt from the watched content.
    return entry as StentPatchStub
  })
}

/**
 * Build a bundler transform whose patch set lives in a JSON file. The returned
 * callback registers the file with the optional watch hook on every module,
 * rereads it on every call, and rebuilds the matcher only when raw content
 * changes. A host bundler must honor `addWatchFile` and connect its watcher/HMR
 * chain for edits to trigger a rebuild; this helper does not provide that
 * integration.
 *
 * @param options - Watched patch file and the build's identity resolver.
 * @returns A transform function `(code, id, addWatchFile?) => output | null`.
 * @throws When the returned callback is called and the file cannot be
 *   read/parsed or its rebuilt patch set is invalid.
 */
function createWatchedBrowserTransform({
  patchesPath,
  resolve,
}: WatchedBrowserTransformOptions): WatchedBrowserTransform {
  let cached:
    | {
        content: string
        transform: (code: string, id: string) => TransformOutput | null
      }
    | undefined
  const transformFor = (
    content: string,
  ): ((code: string, id: string) => TransformOutput | null) => {
    if (cached?.content === content) {
      return cached.transform
    }
    const transform = createBrowserTransform({
      patches: parsePatchesFile(content, patchesPath),
      resolve,
    })
    cached = { content, transform }
    return transform
  }
  return (code, id, addWatchFile) => {
    addWatchFile?.(patchesPath)
    let content: string
    try {
      content = readFileSync(patchesPath, 'utf8')
    } catch (error) {
      throw new Error(
        `stent: cannot read watched patches file ${patchesPath}`,
        { cause: error },
      )
    }
    return transformFor(content)(code, id)
  }
}

export {
  repoSourceResolver,
  createInstrumentedTransform,
  createBrowserTransform,
  createWatchedBrowserTransform,
}
export type {
  ModuleIdentity,
  IdentityResolver,
  RepoSourceResolverOptions,
  TransformOutput,
  BrowserTransform,
  BrowserTransformOptions,
  WatchedBrowserTransformOptions,
  WatchedBrowserTransform,
}
