import { readFileSync } from 'node:fs'
import { Module, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolvePackageIdentity } from '#src/transform/identity'
import {
  getStentTransformer,
  transformStentSource,
} from '#src/transform/matcher'

import { flushBindings } from './bindings.ts'
import type {
  CompileFn,
  LoaderBindingRecorder,
  LoaderHost,
  LoaderState,
} from './types.ts'

/** Package identity resolved for a file the loader is about to transform. */
type ResolvedIdentity = NonNullable<ReturnType<typeof resolvePackageIdentity>>
/** Transformer the active matcher selected for one module. */
type ModuleTransformer = ReturnType<typeof getStentTransformer>

/** The part of a load-hook result the transform reads. */
interface LoadedSource {
  readonly source?: string | ArrayBuffer | NodeJS.TypedArray | null | undefined
}

/** One module the synchronous load hook is about to transform. */
interface LoadRequest {
  readonly state: LoaderState
  readonly transformer: NonNullable<ModuleTransformer>
  readonly result: LoadedSource
  readonly url: string
  readonly format: string | null | undefined
}

/** One CommonJS module the compile wrapper is about to transform. */
interface CompileRequest {
  readonly identity: ResolvedIdentity
  readonly filename: string
  readonly source: string
}

/** Prototype slot holding the CommonJS compile implementation. */
const COMPILE_KEY = '_compile'

/** A module prototype that exposes the CommonJS compile implementation. */
interface CompileHost {
  [COMPILE_KEY]: CompileFn
}

const compileWrapper = { installed: false }

/** Version component used when a Node version omits a segment. */
const ZERO_PART = 0
/** Node major line whose stable synchronous hook minimum is tracked. */
const NODE_22_LINE = 22
/** Node major line whose stable synchronous hook minimum is tracked. */
const NODE_24_LINE = 24
/** First release per Node major line whose synchronous module hooks are stable. */
const SYNC_HOOK_MINIMUMS = new Map([
  [NODE_22_LINE, { minor: 22, patch: 3 }],
  [NODE_24_LINE, { minor: 11, patch: 1 }],
])

/** Whether a Node version string ships stable synchronous module hooks. */
function syncHooksSupportedByVersion(version: string): boolean {
  const parts = version.split('.').map(Number)
  const [major = ZERO_PART, minor = ZERO_PART, patch = ZERO_PART] = parts
  const minimum = SYNC_HOOK_MINIMUMS.get(major)
  if (minimum === undefined) {
    return major > NODE_24_LINE
  }
  return (
    minor > minimum.minor || (minor === minimum.minor && patch >= minimum.patch)
  )
}

/** Select the hook strategy, honoring the two environment overrides first. */
function supportsSyncHooks(): boolean {
  if (process.env.STENT_FORCE_ASYNC_HOOKS === '1') {
    return false
  }
  if (process.env.STENT_FORCE_SYNC_HOOKS === '1') {
    return true
  }
  if (typeof registerHooks !== 'function') {
    return false
  }
  return syncHooksSupportedByVersion(process.versions.node)
}

/** Module format Orchestrion expects for a load-hook format. */
function moduleTypeOf(format: string | null | undefined): 'esm' | 'cjs' {
  if (format === 'module') {
    return 'esm'
  }
  return 'cjs'
}

/** File path used to deduplicate transforms for one module URL. */
function modulePath(url: string): string {
  if (url.startsWith('file:')) {
    return fileURLToPath(url)
  }
  return url
}

/** Read the loader-provided source, falling back to the file on disk. */
function readSource(result: LoadedSource, url: string): string {
  const { source } = result
  if (typeof source === 'string') {
    return source
  }
  if (source instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(source)).toString('utf8')
  }
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(
      source.buffer,
      source.byteOffset,
      source.byteLength,
    ).toString('utf8')
  }
  return readFileSync(fileURLToPath(url), 'utf8')
}

/** Drop the cached transformer for a URL and describe the failed transform. */
function loadFailure(state: LoaderState, url: string, error: unknown): Error {
  state.pending.clear()
  state.transformers.delete(url)
  return new Error(`stent: failed to transform ${url}`, { cause: error })
}

/** Transform one loaded module and record the bindings it produced. */
function runLoadTransform(
  request: LoadRequest,
  path: string,
  recordBindings: LoaderBindingRecorder,
): string {
  const { state, transformer, result, url, format } = request
  try {
    const transformed = transformStentSource(
      transformer,
      readSource(result, url),
      moduleTypeOf(format),
    )
    const identity = resolvePackageIdentity(path)
    if (identity !== undefined) {
      flushBindings(state, identity, recordBindings)
    }
    return transformed.code
  } catch (error) {
    throw loadFailure(state, url, error)
  }
}

/** Transformed source for one load, or undefined when it was already seen. */
function transformLoaded(
  request: LoadRequest,
  recordBindings: LoaderBindingRecorder,
): string | undefined {
  const { state, url } = request
  const path = modulePath(url)
  if (state.seen.has(path)) {
    return undefined
  }
  state.seen.add(path)
  return runLoadTransform(request, path, recordBindings)
}

/** Transformer this installation selects for a resolved module identity. */
function selectTransformer(
  state: LoaderState,
  identity: ResolvedIdentity,
): ModuleTransformer {
  if (!state.active) {
    return undefined
  }
  return getStentTransformer(
    state.matcher,
    identity.name,
    identity.version,
    identity.path,
  )
}

/** Register synchronous ESM and CJS load hooks for one installation. */
function installSynchronousHooks(state: LoaderState, host: LoaderHost): void {
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const resolved = nextResolve(specifier, context)
      if (!state.active) {
        return resolved
      }
      const identity = resolvePackageIdentity(resolved.url)
      if (identity === undefined) {
        return resolved
      }
      const transformer = selectTransformer(state, identity)
      if (transformer !== undefined) {
        state.transformers.set(resolved.url, transformer)
      }
      return resolved
    },
    load: (url, context, nextLoad) => {
      const result = nextLoad(url, context)
      if (!state.active) {
        return result
      }
      const transformer = state.transformers.get(url)
      if (transformer === undefined) {
        return result
      }
      const source = transformLoaded(
        {
          state,
          transformer,
          result,
          url,
          format: context.format,
        },
        host.recordBindings,
      )
      if (source === undefined) {
        return result
      }
      return { ...result, source, shortCircuit: true }
    },
  })
}

/** Restore the seen entry and describe the failed CommonJS transform. */
function compileFailure(
  state: LoaderState,
  filename: string,
  error: unknown,
): Error {
  state.pending.clear()
  state.seen.delete(filename)
  return new Error(`stent: failed to transform ${filename}`, { cause: error })
}

/** Apply one installation's transform to CommonJS source. */
function compileForState(
  state: LoaderState,
  request: CompileRequest,
  recordBindings: LoaderBindingRecorder,
): string {
  const { identity, filename, source } = request
  const transformer = selectTransformer(state, identity)
  if (transformer === undefined || state.seen.has(filename)) {
    return source
  }
  state.seen.add(filename)
  try {
    const transformed = transformStentSource(transformer, source, 'cjs')
    flushBindings(state, identity, recordBindings)
    return transformed.code
  } catch (error) {
    throw compileFailure(state, filename, error)
  }
}

/** Apply every active installation's transform to CommonJS source. */
function applyStentTransforms(
  content: string,
  filename: string,
  states: readonly LoaderState[],
  recordBindings: LoaderBindingRecorder,
): string {
  const identity = resolvePackageIdentity(filename)
  if (identity === undefined) {
    return content
  }
  let source = content
  for (const state of states) {
    source = compileForState(
      state,
      { identity, filename, source },
      recordBindings,
    )
  }
  return source
}

/** Whether a module prototype exposes the CommonJS compile implementation. */
function isCompileHost(value: object): value is CompileHost {
  if (typeof Reflect.get(value, COMPILE_KEY) !== 'function') {
    return false
  }
  return true
}

/** Install the process-wide CommonJS compile wrapper once. */
function installCompileWrapper(host: LoaderHost): void {
  if (compileWrapper.installed) {
    return
  }
  const modulePrototype = Module.prototype
  if (!isCompileHost(modulePrototype)) {
    return
  }
  compileWrapper.installed = true
  const originalCompile = modulePrototype[COMPILE_KEY]
  modulePrototype[COMPILE_KEY] = function stentCompile(
    this: Module,
    content: string,
    filename: string,
  ): unknown {
    const source = applyStentTransforms(
      content,
      filename,
      host.getStates(),
      host.recordBindings,
    )
    return originalCompile.call(this, source, filename)
  }
}

export { installCompileWrapper, installSynchronousHooks, supportsSyncHooks }
