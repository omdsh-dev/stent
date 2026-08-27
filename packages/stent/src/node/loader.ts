/**
 * Node transformation hooks for Stent: installs the bridge handle and the
 * synchronous ESM/CJS load hooks that rewrite target modules with the Stent
 * transformation before they are evaluated.
 *
 * The hooks must be installed before any target module is imported (the Cordis
 * Loader imports plugin modules only after entries are created, so a bootstrap
 * call during application preparation is early enough). The transformation
 * itself is registration-free: transformed code publishes to the bridge
 * channel, and the runtime decides per patch whether a handler is active — so
 * handlers may be registered, enabled, disabled, or disposed after the module
 * was already transformed.
 *
 * The loader has one installation mode: `installStentHooks()`. Runtime metadata
 * changes rebuild its matcher, apply to future loads, and schedule
 * re-transformation for already-loaded matching modules when Node permits it.
 * Handler-only changes still dispatch through the live bridge without code
 * re-transformation.
 *
 * Node's `registerHooks` API has no unregister; hooks compose and stay for the
 * process lifetime. The returned disposer therefore deactivates the loader's
 * state (hooks become pass-through, cached transformers are freed) rather than
 * removing the hook functions themselves.
 *
 * @module @oh-my-dsh/stent/node/internal-loader
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { Module, createRequire, register, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MessagePort } from 'node:worker_threads'

import { installBridge } from '../bridge.ts'
import {
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
  loadedEsmUrls,
} from '../hmr/reload.ts'
import { runtime } from '../runtime.ts'
import {
  expandPatchStub,
  type StentInstrumentationConfig,
} from '../transform/config.ts'
import {
  resolvePackageIdentity,
  type PackageIdentity,
} from '../transform/identity.ts'
import {
  createStentMatcher,
  getStentTransformer,
  orderStentInstrumentations,
  transformStentSource,
  type StentMatcher,
  type StentTransformer,
} from '../transform/matcher.ts'
import { serializeInstrumentation } from '../transform/wire.ts'
import type {
  StentBindingReport,
  StentPatchInfo,
  StentPatchStub,
  PatchId,
} from '../types.ts'
/** The `Module.prototype._compile` internals this loader wraps for CJS. */
type CompileFn = (this: Module, content: string, filename: string) => unknown

/**
 * Verify that every `required` patch recorded at least one load-time binding,
 * and fail loud naming the offenders when any did not. Call after the
 * application boots (the target modules have been imported), so the check
 * observes the bindings the transformation hooks recorded; a required patch
 * whose target never matched is a misconfiguration — wrong launch form (src vs
 * lib), moved function, or renamed module — that would otherwise ship as an
 * inert transform.
 *
 * @throws Listing every required patch that bound nothing.
 */
export function checkRequiredPatches(): void {
  const descriptors = runtime.list().map(patchStubFromInfo)
  const missing = descriptors
    .filter(
      (patch) =>
        patch.required === true && runtime.bindingsOf(patch.id).length === 0,
    )
    .map(
      (patch) =>
        `${patch.id} (${patch.target.module} ${String(patch.target.filePath)}, ${patch.operation})`,
    )
  if (missing.length > 0) {
    throw new Error(
      'stent: required patch(es) bound nothing at load time; the target file may be the wrong '
        + `launch form (src vs lib) or the function may have moved: ${missing.join('; ')}`,
    )
  }
}

/** Loader installation is dynamic and takes no options. */
/** Loader state shared by the dynamic hooks. */
interface LoaderState {
  /** Whether this installation is currently active. */
  active: boolean
  /** Stent matcher with the custom transform registered. */
  matcher: StentMatcher
  /** The ordered instrumentations, serialized to the async hook entry. */
  instrumentations: StentInstrumentationConfig[]
  /** Whether this state uses synchronous Node loader hooks. */
  syncHooks: boolean
  /** Transformers resolved per module URL. */
  transformers: Map<string, StentTransformer>
  /** URLs already transformed (guards the CJS double-path). */
  seen: Set<string>
  /**
   * Per-patch function-node counts accumulating while one file's transform
   * runs; flushed into the runtime's binding records after the file.
   */
  pending: Map<PatchId, number>
  /** Stop listening to runtime patch changes. */
  unsubscribePatchChanges?: () => void
  /** Matchers superseded before the pending retransform microtask runs. */
  pendingPreviousMatchers: StentMatcher[]
  /** Already-loaded module identities captured when a dynamic change arrives. */
  pendingLoadedModules: Set<string>
  /** Whether a loaded-module retransform has already been queued. */
  retransformQueued: boolean
}

/**
 * Record the pending per-patch node counts as load-time bindings for one
 * transformed file. Counts accumulate only while a single file's transform runs
 * (module loads are sequential), so each flush attributes exactly the nodes of
 * the file being loaded.
 *
 * @param state - The active installation.
 * @param identity - The transformed module's package identity.
 */
function flushBindings(state: LoaderState, identity: PackageIdentity): void {
  if (state.pending.size === 0) {
    return
  }
  for (const [patchId, nodes] of state.pending) {
    runtime.recordBindings(patchId, [
      { module: identity.name, file: identity.path, nodes },
    ])
  }
  state.pending.clear()
}

/**
 * One active installation state; disposed states are removed after
 * deactivation.
 */
const states: LoaderState[] = []

/** The require cache used to locate already-loaded CommonJS targets. */
const nodeRequire = createRequire(import.meta.url)

/**
 * Convert runtime metadata back to the descriptor shape consumed by the
 * transform.
 */
function patchStubFromInfo(info: StentPatchInfo): StentPatchStub {
  return {
    id: info.id,
    target: info.target,
    operation: info.operation,
    ...(info.priority === 0 ? {} : { priority: info.priority }),
    ...(info.required === undefined ? {} : { required: info.required }),
  }
}

/** Return the matcher-relevant part of one runtime patch metadata snapshot. */
function patchShapeKey(info: StentPatchInfo): string {
  const target = info.target
  const filePath =
    target.filePath instanceof RegExp
      ? [target.filePath.source, target.filePath.flags]
      : target.filePath
  return JSON.stringify([
    info.id,
    target.module,
    target.versionRange,
    filePath,
    target.filePaths,
    target.index,
    target.functionQuery,
    target.astQuery,
    info.operation,
    info.priority,
  ])
}

/** Build the current instrumentation snapshot from the live runtime registry. */
function currentInstrumentations(): StentInstrumentationConfig[] {
  const runtimePatches = runtime
    .list()
    .flatMap((info) => expandPatchStub(patchStubFromInfo(info)))
  const orderedPatches = orderStentInstrumentations(runtimePatches)
  return orderedPatches
}

/** Construct a matcher and attach its Stent transform callback. */
function createMatcher(
  state: LoaderState,
  instrumentations: StentInstrumentationConfig[],
): StentMatcher {
  return createStentMatcher(instrumentations, (patchId) => {
    state.pending.set(patchId, (state.pending.get(patchId) ?? 0) + 1)
  })
}

/** Clear per-installation transform marks for a reloaded module. */
function clearSeen(filename: string): void {
  for (const installation of states) {
    installation.seen.delete(filename)
  }
}
/** Whether a matcher selects a loaded module identity. */
function matcherSelects(matcher: StentMatcher, path: string): boolean {
  const identity = resolvePackageIdentity(path)
  if (identity === undefined) {
    return false
  }
  const transformer = getStentTransformer(
    matcher,
    identity.name,
    identity.version,
    identity.path,
  )
  if (transformer === undefined) {
    return false
  }
  transformer.free()
  return true
}

/** Queue one loaded-module refresh after the current registration completes. */
function queueLoadedRetransform(state: LoaderState): void {
  if (state.retransformQueued) {
    return
  }
  state.retransformQueued = true
  queueMicrotask(() => {
    state.retransformQueued = false
    if (!state.active) {
      state.pendingPreviousMatchers.length = 0
      state.pendingLoadedModules.clear()
      return
    }
    const previousMatchers = state.pendingPreviousMatchers.splice(0)
    const loadedModules = [...state.pendingLoadedModules]
    state.pendingLoadedModules.clear()
    void retransformLoadedTargets(state, previousMatchers, loadedModules).catch(
      (error: unknown) => {
        process.emitWarning(
          `stent: dynamic target re-transformation failed: ${String(error)}`,
        )
      },
    )
  })
}

/** Re-run loaded targets against the latest dynamic matcher snapshot. */
async function retransformLoadedTargets(
  state: LoaderState,
  previousMatchers: readonly StentMatcher[],
  loadedModules: readonly string[],
): Promise<void> {
  const matchers = [state.matcher, ...previousMatchers]
  const cjsPaths = loadedModules.filter((path) => !path.startsWith('file:'))
  const cjsSet = new Set(cjsPaths)
  const cjsTargets = cjsPaths.filter((path) =>
    matchers.some((matcher) => matcherSelects(matcher, path)),
  )
  for (const path of cjsTargets) {
    reloadCommonJs(path, clearSeen)
  }

  // Node's async module.register fallback cannot safely evict its loader-thread
  // ESM jobs from the main thread; future loads still see the rebuilt config.
  if (!state.syncHooks) {
    return
  }
  const esmTargets = loadedModules
    .filter((url) => url.startsWith('file:'))
    .filter((url) => {
      const path = fileURLToPath(url)
      return (
        !cjsSet.has(path)
        && matchers.some((matcher) => matcherSelects(matcher, url))
      )
    })
  for (const url of esmTargets) {
    await reloadEsm(url, clearSeen)
  }
}

/** Refresh a dynamic installation after a runtime metadata change. */
function refreshDynamicState(state: LoaderState): void {
  const previousMatcher = state.matcher
  for (const path of Object.keys(nodeRequire.cache)) {
    state.pendingLoadedModules.add(path)
  }
  if (state.syncHooks) {
    for (const url of loadedEsmUrls()) {
      state.pendingLoadedModules.add(url)
    }
  }
  for (const transformer of state.transformers.values()) {
    transformer.free()
  }
  state.transformers.clear()
  state.instrumentations = currentInstrumentations()
  state.matcher = createMatcher(state, state.instrumentations)
  state.pendingPreviousMatchers.push(previousMatcher)
  writeAsyncConfig()
  queueLoadedRetransform(state)
}

/**
 * Whether this Node version exposes reliable synchronous `registerHooks`. The
 * API is stable from 22.22.3 / 24.11.1; earlier versions can fail when
 * loader-thread hooks coexist with CommonJS. See
 * https://github.com/nodejs/node/issues/63060 and
 * https://github.com/nodejs/node/issues/56241.
 */
function supportsSyncHooks(): boolean {
  // STENT_FORCE_ASYNC_HOOKS exercises the async `module.register`
  // fallback on runtimes that do have `registerHooks` (test seam).
  if (process.env.STENT_FORCE_ASYNC_HOOKS === '1') {
    return false
  }
  // STENT_FORCE_SYNC_HOOKS exercises the synchronous hooks on runtimes
  // without a competing loader-thread hook (test seam, symmetric with the
  // async override above; source-mode tests have no tsx `module.register`).
  if (process.env.STENT_FORCE_SYNC_HOOKS === '1') {
    return true
  }
  if (typeof registerHooks !== 'function') {
    return false
  }
  const [major = 0, minor = 0, patch = 0] = process.versions.node
    .split('.')
    .map(Number)
  if (major === 22) {
    return minor > 22 || (minor === 22 && patch >= 3)
  }
  if (major === 24) {
    return minor > 11 || (minor === 11 && patch >= 1)
  }
  return major > 24
}

/** Whether the async loader-thread hook entry has been registered (once). */
let asyncHooksInstalled = false

/** Shared configuration file the loader-thread entry reads on every load. */
let asyncConfigPath: string | undefined

/** Main-thread end of the binding-report channel, when the async path is active. */
let asyncBindingPort: MessagePort | undefined

/** Flush requests awaiting the loader thread's `flush-done` reply. */
const flushWaiters: Array<() => void> = []

/**
 * Remove the shared configuration file on process exit (once). The loader
 * thread only reads the file during module loads, which cannot happen after the
 * exit event; a hard crash may leave the pid-scoped file behind and tmpdir
 * policy owns those leftovers.
 */
function scheduleAsyncConfigCleanup(path: string): void {
  process.once('exit', () => {
    try {
      unlinkSync(path)
    } catch {
      // Already removed or never written; nothing else can reach it here.
    }
  })
}

/**
 * Register the async loader-thread hooks (`module.register`) used when the
 * synchronous `registerHooks` API is unavailable (or unreliable — see
 * {@link supportsSyncHooks}). The hook entry runs on the loader thread and
 * transforms matching ESM modules; CommonJS stays on the main thread's
 * `_compile` patch (plain `require()` calls never reach the loader-thread load
 * hook).
 *
 * The entry is registered exactly once; later installations and disposals do
 * not re-register (there is no unregister), they update the shared
 * configuration file, which the entry reads on every load. Registration-time
 * snapshots therefore become load-time state: a new installation replaces the
 * transform on the next module evaluation, disposing one removes its
 * instrumentations, and `retransformEsm` works exactly as on the sync path. A
 * MessagePort accompanies the shared config so the loader thread can report the
 * bindings of the ESM modules it transforms; like the hooks themselves, the
 * port lives for the process lifetime. The main-thread end is unref'd — it must
 * not hold the process open once the loop idles.
 *
 * @param configPath - The shared configuration file path.
 */
function installAsyncHooks(configPath: string): void {
  if (asyncHooksInstalled) {
    return
  }
  asyncHooksInstalled = true
  const channel = new MessageChannel()
  const port = channel.port1
  asyncBindingPort = port
  port.on('message', (message: unknown) => {
    // A flush reply acknowledges that every binding report posted before it
    // on the channel has landed on this thread (same-channel ordering).
    if (
      typeof message === 'object'
      && message !== null
      && (message as { type?: string }).type === 'flush-done'
    ) {
      const waiters = flushWaiters.splice(0)
      for (const resolve of waiters) {
        resolve()
      }
      return
    }
    if (!Array.isArray(message)) {
      return
    }
    for (const record of message) {
      if (typeof record !== 'object' || record === null) {
        continue
      }
      const report = record as Partial<StentBindingReport>
      if (
        typeof report.patchId === 'string'
        && typeof report.module === 'string'
        && typeof report.file === 'string'
        && typeof report.nodes === 'number'
      ) {
        runtime.recordBindings(report.patchId, [
          { module: report.module, file: report.file, nodes: report.nodes },
        ])
      }
    }
  })
  port.unref()
  const directNodeEntry =
    import.meta.url.endsWith('/node/loader.js')
    || import.meta.url.endsWith('/node/loader.ts')
  const hookEntry = directNodeEntry
    ? new URL(
        import.meta.url.endsWith('.ts') ? './hook-entry.ts' : './hook-entry.js',
        import.meta.url,
      )
    : new URL('./node/hook-entry.js', import.meta.url)
  register(hookEntry.href, import.meta.url, {
    data: { configPath, port: channel.port2 },
    transferList: [channel.port2],
  })
}

/**
 * Wait until every binding report the loader thread posted for completed loads
 * has landed on the main thread. A no-op on the synchronous-hooks path
 * (bindings are recorded inline) and when no hooks were installed.
 *
 * The loader thread answers a `flush` request with `flush-done` on the same
 * channel; same-channel ordering guarantees every earlier report precedes the
 * reply. The reply may never come when the entry failed to load (the
 * registration is fire-and-forget), so the timeout keeps the caller from
 * hanging; the caller then sees the reports that did arrive.
 *
 * @param timeoutMs - How long to wait for the reply before proceeding.
 */
export async function flushBindingReports(timeoutMs = 200): Promise<void> {
  if (asyncBindingPort === undefined) {
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      const index = flushWaiters.indexOf(resolve)
      if (index >= 0) {
        flushWaiters.splice(index, 1)
      }
      resolve()
    }, timeoutMs)
    flushWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
    asyncBindingPort?.postMessage({ type: 'flush' })
  })
}

/** Serialize the active dynamic matcher snapshot for the async hook entry. */
function writeAsyncConfig(): void {
  if (!asyncConfigPath) {
    return
  }
  const nextPath = `${asyncConfigPath}.next`
  writeFileSync(
    nextPath,
    JSON.stringify(
      states.map((state) => ({
        active: state.active,
        instrumentations: state.instrumentations.map(serializeInstrumentation),
      })),
    ),
  )
  renameSync(nextPath, asyncConfigPath)
}

/**
 * Install the process-wide dynamic Stent transformation hooks and bridge.
 *
 * The only supported installation form is:
 *
 * ```ts
 * installStentHooks()
 * ```
 *
 * Runtime patch metadata is the single source of truth. Registration updates
 * the matcher for future loads and schedules cache re-transformation for
 * already-loaded matching modules when Node permits it. The hook functions
 * themselves remain process-lifetime globals; the returned disposer deactivates
 * this installation's state.
 *
 * The synchronous and asynchronous hook implementations share one main-thread
 * installation state: the sync path runs ESM and CJS through it, the async path
 * runs CJS through it while the loader thread handles ESM.
 *
 * @returns A disposer that deactivates this installation.
 */
export function installStentHooks(): () => void {
  if (arguments.length !== 0) {
    throw new Error(
      'stent: installStentHooks does not accept arguments; use installStentHooks()',
    )
  }
  if (states.some((state) => state.active)) {
    throw new Error(
      'stent: installStentHooks allows only one active dynamic installation',
    )
  }
  installBridge()
  const syncHooks = supportsSyncHooks()
  if (!syncHooks) {
    if (asyncConfigPath === undefined) {
      asyncConfigPath = join(tmpdir(), `stent-config-${process.pid}.json`)
      scheduleAsyncConfigCleanup(asyncConfigPath)
    }
    installAsyncHooks(asyncConfigPath)
  }

  const state: LoaderState = {
    active: true,
    matcher: undefined as unknown as StentMatcher,
    instrumentations: [],
    syncHooks,
    transformers: new Map(),
    seen: new Set(),
    pending: new Map(),
    pendingPreviousMatchers: [],
    pendingLoadedModules: new Set(),
    retransformQueued: false,
  }
  state.instrumentations = currentInstrumentations()
  state.matcher = createMatcher(state, state.instrumentations)

  states.push(state)
  state.unsubscribePatchChanges = runtime.onPatchChange((change) => {
    if (
      change.type === 'register'
      && change.previous !== undefined
      && change.current !== undefined
      && patchShapeKey(change.previous) === patchShapeKey(change.current)
    ) {
      return
    }
    refreshDynamicState(state)
  })
  if (!syncHooks) {
    writeAsyncConfig()
  }

  if (syncHooks) {
    installSynchronousHooks(state)
  }

  // CommonJS files reached through plain require() (not via the ESM graph)
  // do not pass through the load hook; transform them at compile time. The
  // wrapper is installed once per process and consults the active dynamic
  // installation state, so the disposer needs no restoration.
  installCompileWrapper()

  return () => {
    state.active = false
    state.unsubscribePatchChanges?.()
    delete state.unsubscribePatchChanges
    state.pendingPreviousMatchers.length = 0
    state.pendingLoadedModules.clear()
    const index = states.indexOf(state)
    if (index >= 0) {
      states.splice(index, 1)
    }
    for (const transformer of state.transformers.values()) {
      transformer.free()
    }
    state.transformers.clear()
    writeAsyncConfig()
  }
}

/** Register synchronous ESM and CJS load hooks for one installation. */
function installSynchronousHooks(state: LoaderState): void {
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
      const transformer = getStentTransformer(
        state.matcher,
        identity.name,
        identity.version,
        identity.path,
      )
      if (transformer) {
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
      if (!transformer) {
        return result
      }
      // Track by filesystem path: the CJS `_compile` patch below records the
      // same key, so a CommonJS module reached through both the ESM graph and
      // plain require() is transformed exactly once.
      const path = url.startsWith('file:') ? fileURLToPath(url) : url
      if (state.seen.has(path)) {
        return result
      }
      state.seen.add(path)
      try {
        const source = readSource(result, url)
        const moduleType = context.format === 'module' ? 'esm' : 'cjs'
        const transformed = transformStentSource(
          transformer,
          source,
          moduleType,
        )
        const identity = resolvePackageIdentity(path)
        if (identity !== undefined) {
          flushBindings(state, identity)
        }
        return { ...result, source: transformed.code, shortCircuit: true }
      } catch (error) {
        state.pending.clear()
        state.transformers.delete(url)
        throw new Error(`stent: failed to transform ${url}`, { cause: error })
      }
    },
  })
}

/** Whether the singleton CJS `_compile` wrapper is installed. */
let compileWrapperInstalled = false

/**
 * Install the process-wide `_compile` wrapper once. With no active installation
 * it passes through to the original compile function; the one active dynamic
 * installation supplies the current runtime matcher. Disposed installations are
 * spliced out of the state list and skipped.
 */
function installCompileWrapper(): void {
  if (compileWrapperInstalled) {
    return
  }
  compileWrapperInstalled = true
  const modulePrototype = Module.prototype as unknown as Record<string, unknown>
  const compileKey = '_compile'
  const originalCompile = modulePrototype[compileKey] as CompileFn
  modulePrototype[compileKey] = function (
    this: Module,
    content: string,
    filename: string,
  ) {
    const identity = resolvePackageIdentity(filename)
    if (identity !== undefined) {
      for (const state of states) {
        if (!state.active) {
          continue
        }
        const transformer = getStentTransformer(
          state.matcher,
          identity.name,
          identity.version,
          identity.path,
        )
        if (!transformer || state.seen.has(filename)) {
          continue
        }
        state.seen.add(filename)
        try {
          content = transformStentSource(transformer, content, 'cjs').code
          flushBindings(state, identity)
        } catch (error) {
          state.pending.clear()
          state.seen.delete(filename)
          throw new Error(`stent: failed to transform ${filename}`, {
            cause: error,
          })
        }
      }
    }
    return originalCompile.call(this, content, filename)
  }
}

/**
 * Resolve the source text of a module being loaded.
 *
 * @param result - The load-hook result.
 * @param url - The module URL, used to read CommonJS sources Node leaves null.
 * @returns The source string.
 */
function readSource(
  result: {
    source?: string | ArrayBuffer | NodeJS.TypedArray | null | undefined
  },
  url: string,
): string {
  if (typeof result.source === 'string') {
    return result.source
  }
  if (result.source instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(result.source)).toString('utf8')
  }
  if (result.source != null) {
    return Buffer.from(result.source as Uint8Array).toString('utf8')
  }
  return readFileSync(fileURLToPath(url), 'utf8')
}

/**
 * Re-evaluate an already-loaded CommonJS module under the current
 * instrumentation stack.
 *
 * HMR-style invalidation for CommonJS: the module's `require.cache` entry is
 * dropped and its `seen` marks are cleared, so the next `require()` runs the
 * `_compile` wrapper again and transforms the module with the top-of-stack
 * installation's current matcher. The same file may also sit in the ESM graph
 * (import()ed): its `loadCache` entry is evicted too (the same dual-cache
 * invalidation the vendored Loader's HMR performs), so both graphs observe the
 * fresh evaluation. The returned value is the NEW module exports object;
 * references to the old one keep the old transformation.
 *
 * @param filename - The absolute module path used as the `require.cache` key.
 * @returns The freshly evaluated module exports.
 */
export function retransformCommonJs(filename: string): unknown {
  return reloadCommonJs(filename, (path) => {
    for (const state of states) {
      state.seen.delete(path)
    }
  })
}

/**
 * Re-evaluate an already-loaded ESM module under the current instrumentation
 * stack.
 *
 * HMR-style invalidation for ESM: the module's entry in Node's internal
 * `loadCache` is evicted (the same mechanism the vendored Loader's HMR uses)
 * and the `seen` marks are cleared, so the next `import()` of the same URL
 * re-evaluates the module and the load hooks transform it with the top-of-stack
 * installation's current matcher. The returned value is the NEW module
 * namespace; references to the old one keep the old transformation.
 *
 * A failed re-import restores the evicted cache entry (the same rollback the
 * vendored Loader's HMR performs): the module falls back to the previous
 * instance instead of being left unevaluatable, and a later `import()` of the
 * URL serves the restored instance without re-evaluating it.
 *
 * Requires the Node internal loader (Node >= 22) and the synchronous
 * `registerHooks` path — the async `module.register` fallback transforms ESM in
 * the loader thread, where a main-thread eviction alone does not reach.
 *
 * @param url - The module URL used as the `loadCache` key.
 * @returns The freshly evaluated module namespace.
 */
export async function retransformEsm(
  url: string,
): Promise<Record<string, unknown>> {
  return reloadEsm(url, (path) => {
    for (const state of states) {
      state.seen.delete(path)
    }
  })
}
