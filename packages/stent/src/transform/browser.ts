/**
 * Build-time Stent transform for a Node-capable bundler.
 *
 * `.ts`/`.tsx` source is transpiled with `ts.transpileModule` (including JSX)
 * before Orchestrion parses it; matcher selection is shared with Node, while
 * module type detection here is extension-based. This module backs
 * `@oh-my-dsh/stent/browser`.
 *
 * @module @oh-my-dsh/stent/transform/browser
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { StentInstrumentationConfig } from './config.ts'
import { expandPatchStub } from './config.ts'
import { InstrumentedTransformController } from './instrumented-transform.ts'
import type {
  IdentityResolver,
  ModuleIdentity,
  TransformOutput,
} from './matcher.ts'
import type { StentPatchStub } from './types.ts'

interface RepoSourceResolverOptions {
  /** Npm package name of the built client plugin. */
  readonly packageName: string
  /** Source root used for exact prefix matching; normally an absolute path. */
  readonly packageRoot: string
  /** Package version used for `versionRange` matching; not put in bridge calls. */
  readonly version: string
}

/** Resolve repository source modules via a raw `packageRoot` prefix. */
function repoSourceResolver({
  packageName,
  packageRoot,
  version,
}: RepoSourceResolverOptions): IdentityResolver {
  let root = packageRoot
  if (!packageRoot.endsWith('/')) {
    root = `${packageRoot}/`
  }
  return (id): ModuleIdentity | undefined => {
    if (!id.startsWith(root)) {
      return undefined
    }
    return {
      name: packageName,
      version,
      path: path.relative(packageRoot, id).replaceAll('\\', '/'),
    }
  }
}

/** A bundler transform for one set of Stent patches. */
type BrowserTransform = (code: string, id: string) => TransformOutput | null

interface BrowserTransformOptions {
  readonly patches: readonly StentPatchStub[]
  readonly resolve: IdentityResolver
}

interface WatchedBrowserTransformOptions {
  readonly patchesPath: string
  readonly resolve: IdentityResolver
}

function createInstrumentedTransform(
  instrumentations: readonly StentInstrumentationConfig[],
  resolve: IdentityResolver,
): BrowserTransform {
  const controller = new InstrumentedTransformController(
    instrumentations,
    resolve,
  )
  const transform = (code: string, id: string): TransformOutput | null => {
    const output = controller.transform(code, id)
    return output
  }
  return transform
}

function createBrowserTransform({
  patches,
  resolve,
}: BrowserTransformOptions): BrowserTransform {
  return createInstrumentedTransform(
    patches.flatMap((patch) => expandPatchStub(patch)),
    resolve,
  )
}

/** Browser transform that also receives the bundler's watch-file hook. */
type WatchedBrowserTransform = ((
  code: string,
  id: string,
  addWatchFile?: (file: string) => void,
) => TransformOutput | null) & {
  readonly dispose: () => void
}

/** Parse the JSON body of a watched patches file or throw with its path. */
function parsePatchesJson(content: string, patchesPath: string): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new Error(
      `stent: cannot parse watched patches file ${patchesPath} as JSON`,
      { cause: error },
    )
  }
}

/** Whether a JSON entry is a patch stub with an object target. */
function validPatchStubEntry(entry: unknown): entry is StentPatchStub {
  if (typeof entry !== 'object' || entry === null) {
    return false
  }
  const { target } = entry as { target?: unknown }
  return typeof target === 'object' && target !== null
}

/** Parse the watched patches file's outer JSON shape. */
function parsePatchesFile(
  content: string,
  patchesPath: string,
): StentPatchStub[] {
  const parsed = parsePatchesJson(content, patchesPath)
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `stent: watched patches file ${patchesPath} must hold a JSON array of patch stubs`,
    )
  }
  return parsed.map((entry: unknown, index): StentPatchStub => {
    if (!validPatchStubEntry(entry)) {
      throw new Error(
        `stent: watched patches file ${patchesPath} entry ${index} must be a patch stub object with a target`,
      )
    }
    /* The remaining static fields are validated by createBrowserTransform, which expands the query when rebuilt. */
    return entry
  })
}

/** Owns the watched patch file cache and its transform lifecycle. */
class WatchedBrowserTransformController {
  #cached:
    | {
        content: string
        transform: (code: string, id: string) => TransformOutput | null
      }
    | undefined
  readonly #patchesPath: string
  readonly #resolve: IdentityResolver

  public constructor(options: WatchedBrowserTransformOptions) {
    this.#patchesPath = options.patchesPath
    this.#resolve = options.resolve
  }

  public dispose(): void {
    this.#cached = undefined
  }

  public transform(
    code: string,
    id: string,
    addWatchFile?: (file: string) => void,
  ): TransformOutput | null {
    addWatchFile?.(this.#patchesPath)
    let content = ''
    try {
      content = readFileSync(this.#patchesPath, 'utf8')
    } catch (error) {
      throw new Error(
        `stent: cannot read watched patches file ${this.#patchesPath}`,
        { cause: error },
      )
    }
    return this.transformFor(content)(code, id)
  }

  private transformFor(
    content: string,
  ): (code: string, id: string) => TransformOutput | null {
    if (this.#cached?.content === content) {
      return this.#cached.transform
    }
    const transform = createBrowserTransform({
      patches: parsePatchesFile(content, this.#patchesPath),
      resolve: this.#resolve,
    })
    this.#cached = { content, transform }
    return transform
  }
}

/** Build a bundler transform whose patch set lives in a JSON file. */
function createWatchedBrowserTransform({
  patchesPath,
  resolve,
}: WatchedBrowserTransformOptions): WatchedBrowserTransform {
  const controller = new WatchedBrowserTransformController({
    patchesPath,
    resolve,
  })
  const transform: WatchedBrowserTransform = Object.assign(
    (code: string, id: string, addWatchFile?: (file: string) => void) =>
      controller.transform(code, id, addWatchFile),
    {
      dispose: (): void => {
        controller.dispose()
      },
    },
  )
  return transform
}

export {
  repoSourceResolver,
  createInstrumentedTransform,
  createBrowserTransform,
  createWatchedBrowserTransform,
}
export type {
  IdentityResolver,
  ModuleIdentity,
  TransformOutput,
} from './matcher.ts'
export type {
  RepoSourceResolverOptions,
  BrowserTransform,
  BrowserTransformOptions,
  WatchedBrowserTransformOptions,
  WatchedBrowserTransform,
}
