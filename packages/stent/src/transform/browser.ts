/**
 * Browser build transform for Stent: a bundler-agnostic code transform that
 * applies the Stent rewrite to target modules during a client bundle build.
 *
 * Client bundles build from repository source paths, so this factory accepts a
 * caller-provided identity resolver: map a module id to `{ name, version,
 * path }` (package name, version, package-relative path) and the matcher runs
 * exactly as it does for the Node loader.
 *
 * Like the Node path, the transform parses emitted JavaScript: TypeScript
 * sources must be compiled before transformation, or the parse fails loudly.
 * This module is an internal implementation used by the public
 * `@oh-my-dsh/stent/browser` entry.
 * @module @oh-my-dsh/stent/transform/browser
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import ts from 'typescript'
import { detectModuleType } from './identity.ts'
import { createStentMatcher, getStentTransformer, transformStentSource } from './matcher.ts'
import { expandPatchStub, type StentInstrumentationConfig } from './config.ts'
import type { StentBindingReport, StentPatchStub } from '../types.ts'

/**
 * Strip TypeScript type annotations so the code transformer (a plain
 * JavaScript parser) can parse `.ts`/`.tsx` sources. Type stripping only
 * removes annotations; the emitted JavaScript keeps module and function
 * shapes intact.
 * @param code - TypeScript source.
 * @returns the equivalent JavaScript source.
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
export interface ModuleIdentity {
  /** npm package name. */
  name: string
  /** Installed or declared package version. */
  version: string
  /** File path relative to the package root. */
  path: string
}

/** Map a bundler module id to its package identity; `undefined` skips it. */
export type IdentityResolver = (id: string) => ModuleIdentity | undefined

/** Options for {@link repoSourceResolver}. */
export interface RepoSourceResolverOptions {
  /** npm package name of the built client plugin. */
  packageName: string
  /** Absolute source root of the package. */
  packageRoot: string
  /** Package version stamped into transformed calls. */
  version: string
}

/**
 * Resolve repository source modules: any id under `packageRoot` maps to the
 * given package name and version. This is the resolver client plugin builds
 * use, since their sources live at `packages/<group>/<name>/src/...`.
 * @param options - package identity and source-root options.
 * @returns an identity resolver for that package's sources.
 */
export function repoSourceResolver({ packageName, packageRoot, version }: RepoSourceResolverOptions): IdentityResolver {
  const root = packageRoot.endsWith('/') ? packageRoot : `${packageRoot}/`
  return id => {
    if (!id.startsWith(root)) return undefined
    return { name: packageName, version, path: relative(packageRoot, id).replaceAll('\\', '/') }
  }
}

/** A transformed module: rewritten source plus an optional source map. */
export interface TransformOutput {
  /** Rewritten source code. */
  code: string
  /** Source map when the underlying transformer produced one. */
  map?: string
  /** Per-patch binding reports for this module, when anything was rewritten. */
  bindings?: StentBindingReport[]
}

/** A bundler transform for one set of Stent patches. */
export type BrowserTransform = (code: string, id: string) => TransformOutput | null

/** Options for {@link createBrowserTransform}. */
export interface BrowserTransformOptions {
  /** Static patch stubs to apply during the bundle build. */
  patches: readonly StentPatchStub[]
  /** Resolver mapping a bundler module id to its package identity. */
  resolve: IdentityResolver
}

/** Options for {@link createWatchedBrowserTransform}. */
export interface WatchedBrowserTransformOptions {
  /** Absolute path of the JSON patch-stub file to watch. */
  patchesPath: string
  /** Resolver mapping a bundler module id to its package identity. */
  resolve: IdentityResolver
}

/**
 * Build a transform from already-expanded internal instrumentation configs.
 * Node's loader-thread entry uses this boundary after reviving its wire data;
 * browser consumers should use {@link createBrowserTransform} with patch stubs.
 * @param instrumentations - expanded Stent instrumentation configs.
 * @param resolve - module identity resolver for the build's source layout.
 * @returns a transform function `(code, id) => output | null`.
 */
export function createInstrumentedTransform(
  instrumentations: readonly StentInstrumentationConfig[],
  resolve: IdentityResolver,
): BrowserTransform {
  // Per-call pending counts: the transform function below runs once per
  // module, so counts accumulated during one call belong to that module.
  const pending = new Map<string, number>()
  const matcher = createStentMatcher(instrumentations, patchId => {
    pending.set(patchId, (pending.get(patchId) ?? 0) + 1)
  })

  return (code, id) => {
    const identity = resolve(id)
    if (!identity) return null
    const transformer = getStentTransformer(matcher, identity.name, identity.version, identity.path)
    if (!transformer) return null
    // TypeScript sources are stripped to plain JavaScript first; the source
    // map is intentionally not chained through the strip step.
    const source = /\.tsx?$/.test(id) ? stripTypes(code, id) : code
    pending.clear()
    const result = transformStentSource(transformer, source, detectModuleType(id))
    const output: TransformOutput =
      result.map === undefined ? { code: result.code } : { code: result.code, map: result.map }
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
 * Build a browser bundle transform from public Stent patch stubs.
 * @param options - patch stubs and the build's identity resolver.
 * @returns a transform function `(code, id) => output | null`.
 */
export function createBrowserTransform({ patches, resolve }: BrowserTransformOptions): BrowserTransform {
  return createInstrumentedTransform(patches.flatMap(expandPatchStub), resolve)
}

/**
 * A browser transform that also receives the bundler's watch-file
 * registration hook (the third argument `clientBundle`'s source-transform
 * plugin forwards), so a file-backed patch set joins the watch graph.
 */
export type WatchedBrowserTransform = (
  code: string,
  id: string,
  addWatchFile?: (file: string) => void,
) => TransformOutput | null

/**
 * Parse the watched patches file: a JSON array of static patch stubs for the
 * browser build API. The Node DSH launcher does not read profile patch
 * descriptors; browser transforms are explicitly assembled from this file
 * when a bundle needs static instrumentation. JSON cannot express a `RegExp`
 * `filePath`, so file paths are strings here. Every malformed entry fails
 * loud at build time rather than installing a never-matching transform.
 * @param content - raw file content.
 * @param patchesPath - file path, used in error messages.
 * @returns the validated patch stubs.
 */
function parsePatchesFile(content: string, patchesPath: string): StentPatchStub[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`stent: cannot parse watched patches file ${patchesPath} as JSON`, { cause: error })
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`stent: watched patches file ${patchesPath} must hold a JSON array of patch stubs`)
  }
  return parsed.map((entry: unknown, index) => {
    const target: unknown =
      typeof entry === 'object' && entry !== null ? (entry as { target?: unknown }).target : undefined
    if (typeof entry !== 'object' || entry === null || typeof target !== 'object' || target === null) {
      throw new Error(
        `stent: watched patches file ${patchesPath} entry ${index} must be a patch stub object with a target`,
      )
    }
    // patchInstrumentation (called by the caller's transform rebuild)
    // validates the remaining fields: id, module, versionRange, filePath,
    // operation, and the function/AST query.
    return entry as StentPatchStub
  })
}

/**
 * Build a bundler transform whose patch set lives in a JSON file, for the
 * dev rebuild chain: the returned transform registers the file in the
 * bundler's watch graph on every module (a patch edit can make a previously
 * unmatched module match, so every module must re-run), re-reads it per
 * module, and rebuilds the underlying matcher only when the content
 * changed — the same read-per-use, rebuild-on-content-change pattern the
 * async loader-thread entry uses for its shared configuration file.
 *
 * Wired through `clientBundle(id, libEntry, { transform })`, an edit to the
 * patches file triggers a bundle rebuild under `tsdown --watch`
 * (`scripts/dev-web.ts`), and the rebuilt bundle rides the client-hmr
 * chain (stat poll → `rebuilt` frame → invalidate/prefetch/fiber swap) into
 * the browser: the build trigger for browser re-transformation.
 * @param options - watched patch file and the build's identity resolver.
 * @returns a transform function `(code, id, addWatchFile?) => output | null`.
 */
export function createWatchedBrowserTransform({
  patchesPath,
  resolve,
}: WatchedBrowserTransformOptions): WatchedBrowserTransform {
  let cached: { content: string; transform: (code: string, id: string) => TransformOutput | null } | undefined
  const transformFor = (content: string): ((code: string, id: string) => TransformOutput | null) => {
    if (cached?.content === content) return cached.transform
    const transform = createBrowserTransform({ patches: parsePatchesFile(content, patchesPath), resolve })
    cached = { content, transform }
    return transform
  }
  return (code, id, addWatchFile) => {
    addWatchFile?.(patchesPath)
    let content: string
    try {
      content = readFileSync(patchesPath, 'utf8')
    } catch (error) {
      throw new Error(`stent: cannot read watched patches file ${patchesPath}`, { cause: error })
    }
    return transformFor(content)(code, id)
  }
}
