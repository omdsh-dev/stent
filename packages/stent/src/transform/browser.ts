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
import type {
  IdentityResolver,
  ModuleIdentity,
  TransformOutput,
} from './matcher.ts'
import { createStentMatcher, transformModuleState } from './matcher.ts'
import type { StentPatchStub } from './types.ts'

/** Per-call pending-node counters. */
const NO_PENDING_BINDINGS = 0
const BINDING_INCREMENT = 1

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
  const pending = new Map<string, number>()
  const matcher = createStentMatcher(instrumentations, (patchId) => {
    pending.set(
      patchId,
      (pending.get(patchId) ?? NO_PENDING_BINDINGS) + BINDING_INCREMENT,
    )
  })
  return (code, id) =>
    transformModuleState(code, id, { matcher, pending, resolve })
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
type WatchedBrowserTransform = (
  code: string,
  id: string,
  addWatchFile?: (file: string) => void,
) => TransformOutput | null

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

/** Cached build state for one watched file content. */
interface CachedPatches {
  content: string
  transform: (code: string, id: string) => TransformOutput | null
}

/** Build a bundler transform whose patch set lives in a JSON file. */
function createWatchedBrowserTransform({
  patchesPath,
  resolve,
}: WatchedBrowserTransformOptions): WatchedBrowserTransform {
  let cached: CachedPatches | undefined = undefined
  const transformFor = (content: string): CachedPatches['transform'] => {
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
    let content = ''
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
