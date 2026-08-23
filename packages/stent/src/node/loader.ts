/**
 * Node transformation hooks for Stent: installs the bridge handle and the
 * synchronous ESM/CJS load hooks that rewrite target modules with the
 * Orchestrion Stent transform before they are evaluated.
 *
 * The hooks must be installed before any target module is imported (the
 * Cordis Loader imports plugin modules only after entries are created, so a
 * bootstrap call during application preparation is early enough). The
 * transformation itself is registration-free: transformed code publishes to
 * the bridge channel, and the runtime decides per patch whether a handler is
 * active — so handlers may be registered, enabled, disabled, or disposed
 * after the module was already transformed.
 *
 * Node's `registerHooks` API has no unregister; hooks compose and stay for
 * the process lifetime. The returned disposer therefore deactivates the
 * loader's state (hooks become pass-through, cached transformers are freed)
 * rather than removing the hook functions themselves.
 * @module @oh-my-dsh/stent/node/loader
 */

import { Module, register, registerHooks } from 'node:module'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MessagePort } from 'node:worker_threads'
import { create } from '@apm-js-collab/code-transformer'
import { installBridge } from '../bridge.ts'
import { nodePackageIdentity, type PackageIdentity } from './identity.ts'
import { runtime } from '../runtime.ts'
import { retransformCommonJs as reloadCommonJs, retransformEsm as reloadEsm } from '../hmr/reload.ts'
import { registerStentTransform } from '../transform/transform.ts'
import { expandPatchStub, orderInstrumentations, type StentInstrumentationConfig } from '../transform/config.ts'
import { serializeInstrumentation, reviveInstrumentation } from './wire.ts'
import type { StentBindingReport, StentPatchStub, PatchId } from '../types.ts'

export type { StentInstrumentationConfig, InstrumentationConfig } from '../transform/config.ts'
export { expandPatchStub, orderInstrumentations, patchInstrumentation } from '../transform/config.ts'
export { reviveInstrumentation, serializeInstrumentation }
export type { StentWireInstrumentation } from './wire.ts'

/** The `Module.prototype._compile` internals this loader wraps for CJS. */
type CompileFn = (this: Module, content: string, filename: string) => unknown

/**
 * Convenience bootstrap for application preparation: validate patches, build
 * their instrumentations, and install the transformation hooks. Call this in
 * the host's `boot()` `prepare` hook (or any point before the target plugin's
 * first import); then mount `StentService` and let patch plugins register
 * handlers through `ctx.stent.register`.
 * @param patches - validated patch descriptors; each target must carry a
 * `functionQuery` or `astQuery`.
 * @returns a disposer that deactivates the installation.
 */
export function bootstrapStent(patches: StentPatchStub[]): () => void {
  return installStentHooks(patches.flatMap(expandPatchStub))
}

/**
 * Verify that every `required` patch recorded at least one load-time
 * binding, and fail loud naming the offenders when any did not. Call after
 * the application boots (the target modules have been imported), so the
 * check observes the bindings the transformation hooks recorded; a required
 * patch whose target never matched is a misconfiguration — wrong launch
 * form (src vs lib), moved function, or renamed module — that would
 * otherwise ship as an inert transform.
 * @param patches - the patch descriptors the bootstrap was installed with.
 * @throws listing every required patch that bound nothing.
 */
export function checkRequiredPatches(patches: readonly StentPatchStub[]): void {
  const missing = patches
    .filter(patch => patch.required === true && runtime.bindingsOf(patch.id).length === 0)
    .map(patch => `${patch.id} (${patch.target.module} ${String(patch.target.filePath)}, ${patch.operation})`)
  if (missing.length > 0) {
    throw new Error(
      'stent: required patch(es) bound nothing at load time; the target file may be the wrong ' +
        `launch form (src vs lib) or the function may have moved: ${missing.join('; ')}`,
    )
  }
}

/** Loader state shared by every hook installation of this module. */
interface LoaderState {
  /** Whether this installation is currently active. */
  active: boolean
  /** Orchestrion matcher with the Stent transform registered. */
  matcher: ReturnType<typeof create>
  /** The ordered instrumentations, serialized to the async hook entry. */
  instrumentations: StentInstrumentationConfig[]
  /** Transformers resolved per module URL. */
  transformers: Map<string, ReturnType<ReturnType<typeof create>['getTransformer']>>
  /** URLs already transformed (guards the CJS double-path). */
  seen: Set<string>
  /**
   * Per-patch function-node counts accumulating while one file's transform
   * runs; flushed into the runtime's binding records after the file.
   */
  pending: Map<PatchId, number>
}

/**
 * Record the pending per-patch node counts as load-time bindings for one
 * transformed file. Counts accumulate only while a single file's transform
 * runs (module loads are sequential), so each flush attributes exactly the
 * nodes of the file being loaded.
 * @param state - the active installation.
 * @param identity - the transformed module's package identity.
 */
function flushBindings(state: LoaderState, identity: PackageIdentity): void {
  if (state.pending.size === 0) return
  for (const [patchId, nodes] of state.pending) {
    runtime.recordBindings(patchId, [{ module: identity.name, file: identity.path, nodes }])
  }
  state.pending.clear()
}

/** Active installations in installation order. Each installation's ESM hooks
 * capture their own state, and the CJS `_compile` wrapper chains every active
 * installation in order, so concurrent installations all transform through
 * their own matchers. */
const states: LoaderState[] = []

/**
 * Resolve a loaded module's package identity: installed packages through
 * their node_modules boundary, workspace packages through their nearest
 * package.json (Node realpaths workspace links, so the npm-layout parser
 * alone cannot name them).
 * @param urlOrPath - the module URL or filesystem path.
 * @returns the identity for the matcher, or undefined outside any package.
 */
function moduleIdentity(urlOrPath: string): PackageIdentity | undefined {
  return nodePackageIdentity(urlOrPath)
}

/**
 * Whether this Node version exposes a reliable synchronous `registerHooks`
 * API. The function exists from 22.19.0, but before 22.22.3 / 24.11.1 its
 * synchronous load chain returns no source for CommonJS modules when
 * loader-thread hooks (`module.register`, e.g. tsx on those versions) are
 * also present, which crashes Node's load validation; the stable API lands
 * in 22.22.3 and 24.11.1. Below those, the async fallback keeps every hook
 * on one loader-thread chain.
 *
 * Bug sources: the CJS/loader-hook coexistence crash is tracked in
 * https://github.com/nodejs/node/issues/63060 ("CJS module customized by
 * synchronous customization hooks uses synthetic `require` with any use of
 * `--loader`"); the registerHooks API's known caveats and the
 * 22.22.3/24.11.1 stabilization boundary are tracked in
 * https://github.com/nodejs/node/issues/56241 (module.registerHooks()
 * tracking issue).
 */
function supportsSyncHooks(): boolean {
  // STENT_FORCE_ASYNC_HOOKS exercises the async `module.register`
  // fallback on runtimes that do have `registerHooks` (test seam).
  if (process.env.STENT_FORCE_ASYNC_HOOKS === '1') return false
  // STENT_FORCE_SYNC_HOOKS exercises the synchronous hooks on runtimes
  // without a competing loader-thread hook (test seam, symmetric with the
  // async override above; source-mode tests have no tsx `module.register`).
  if (process.env.STENT_FORCE_SYNC_HOOKS === '1') return true
  if (typeof registerHooks !== 'function') return false
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number)
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3)
  if (major === 24) return minor > 11 || (minor === 11 && patch >= 1)
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
 * thread only reads the file during module loads, which cannot happen after
 * the exit event; a hard crash may leave the pid-scoped file behind and
 * tmpdir policy owns those leftovers.
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
 * `_compile` patch (plain `require()` calls never reach the loader-thread
 * load hook).
 *
 * The entry is registered exactly once; later installations and disposals do
 * not re-register (there is no unregister), they update the shared
 * configuration file, which the entry reads on every load. Registration-time
 * snapshots therefore become load-time state: a new installation replaces
 * the transform on the next module evaluation, disposing one removes its
 * instrumentations, and `retransformEsm` works exactly as on the sync path.
 * A MessagePort accompanies the shared config so the loader thread can
 * report the bindings of the ESM modules it transforms; like the hooks
 * themselves, the port lives for the process lifetime. The main-thread end
 * is unref'd — it must not hold the process open once the loop idles.
 * @param configPath - the shared configuration file path.
 */
function installAsyncHooks(configPath: string): void {
  if (asyncHooksInstalled) return
  asyncHooksInstalled = true
  const channel = new MessageChannel()
  const port = channel.port1
  asyncBindingPort = port
  port.on('message', (message: unknown) => {
    // A flush reply acknowledges that every binding report posted before it
    // on the channel has landed on this thread (same-channel ordering).
    if (typeof message === 'object' && message !== null && (message as { type?: string }).type === 'flush-done') {
      const waiters = flushWaiters.splice(0)
      for (const resolve of waiters) resolve()
      return
    }
    if (!Array.isArray(message)) return
    for (const record of message) {
      if (typeof record !== 'object' || record === null) continue
      const report = record as Partial<StentBindingReport>
      if (
        typeof report.patchId === 'string' &&
        typeof report.module === 'string' &&
        typeof report.file === 'string' &&
        typeof report.nodes === 'number'
      ) {
        runtime.recordBindings(report.patchId, [{ module: report.module, file: report.file, nodes: report.nodes }])
      }
    }
  })
  port.unref()
  const directNodeEntry = import.meta.url.endsWith('/node/loader.js') || import.meta.url.endsWith('/node/loader.ts')
  const hookEntry = directNodeEntry
    ? new URL(import.meta.url.endsWith('.ts') ? './hook-entry.ts' : './hook-entry.js', import.meta.url)
    : new URL('./node/hook-entry.js', import.meta.url)
  register(hookEntry.href, import.meta.url, {
    data: { configPath, port: channel.port2 },
    transferList: [channel.port2],
  })
}

/**
 * Wait until every binding report the loader thread posted for completed
 * loads has landed on the main thread. A no-op on the synchronous-hooks path
 * (bindings are recorded inline) and when no hooks were installed.
 *
 * The loader thread answers a `flush` request with `flush-done` on the same
 * channel; same-channel ordering guarantees every earlier report precedes
 * the reply. The reply may never come when the entry failed to load (the
 * registration is fire-and-forget), so the timeout keeps the caller from
 * hanging; the caller then sees the reports that did arrive.
 * @param timeoutMs - how long to wait for the reply before proceeding.
 */
export async function flushBindingReports(timeoutMs = 200): Promise<void> {
  if (asyncBindingPort === undefined) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      const index = flushWaiters.indexOf(resolve)
      if (index >= 0) flushWaiters.splice(index, 1)
      resolve()
    }, timeoutMs)
    flushWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
    asyncBindingPort?.postMessage({ type: 'flush' })
  })
}

/** Serialize the installation stack for the async hook entry. */
function writeAsyncConfig(): void {
  if (!asyncConfigPath) return
  writeFileSync(
    asyncConfigPath,
    JSON.stringify(
      states.map(state => ({
        active: state.active,
        instrumentations: state.instrumentations.map(serializeInstrumentation),
      })),
    ),
  )
}

/**
 * Install Stent transformation hooks and the bridge handle.
 *
 * Registers the bridge into `globalThis` and registers synchronous module
 * hooks that transform matching modules on load (or the async loader-thread
 * fallback when `registerHooks` is unavailable). Every config must carry
 * `transform: 'stent'` plus the `stentPatchId` / `stentOperation` fields
 * the Stent transform reads from the merged state.
 *
 * Both hook modes share one main-thread installation state: the sync path
 * runs ESM and CJS through it, the async path runs CJS through it while the
 * loader thread handles ESM.
 * @param instrumentations - Orchestrion configs selecting target modules,
 * files, and functions.
 * @returns a disposer that deactivates this installation (hooks themselves
 * stay registered for the process lifetime).
 */
export function installStentHooks(instrumentations: StentInstrumentationConfig[]): () => void {
  installBridge()
  const ordered = orderInstrumentations(instrumentations)
  const syncHooks = supportsSyncHooks()
  if (!syncHooks) {
    if (asyncConfigPath === undefined) {
      asyncConfigPath = join(tmpdir(), `stent-config-${process.pid}.json`)
      scheduleAsyncConfigCleanup(asyncConfigPath)
    }
    installAsyncHooks(asyncConfigPath)
  }

  const matcher = create(ordered)
  const state: LoaderState = {
    active: true,
    instrumentations: ordered,
    matcher,
    transformers: new Map(),
    seen: new Set(),
    pending: new Map(),
  }
  // Every node the transform actually rewrites increments the installation's
  // pending counts; flushBindings turns them into runtime binding records
  // after each transformed file.
  registerStentTransform(matcher, patchId => {
    state.pending.set(patchId, (state.pending.get(patchId) ?? 0) + 1)
  })

  states.push(state)
  if (!syncHooks) writeAsyncConfig()

  if (syncHooks) {
    registerHooks({
      resolve: (specifier, context, nextResolve) => {
        const resolved = nextResolve(specifier, context)
        if (!state.active) return resolved
        const identity = moduleIdentity(resolved.url)
        if (identity === undefined) return resolved
        const transformer = state.matcher.getTransformer(identity.name, identity.version, identity.path)
        if (transformer) state.transformers.set(resolved.url, transformer)
        return resolved
      },
      load: (url, context, nextLoad) => {
        const result = nextLoad(url, context)
        const stateRef = state
        if (!stateRef.active) return result
        const transformer = stateRef.transformers.get(url)
        if (!transformer) return result
        // Track by filesystem path: the CJS `_compile` patch below records the
        // same key, so a CommonJS module reached through both the ESM graph and
        // plain require() is transformed exactly once.
        const path = url.startsWith('file:') ? fileURLToPath(url) : url
        if (stateRef.seen.has(path)) return result
        stateRef.seen.add(path)
        try {
          const source = readSource(result, url)
          const moduleType = context.format === 'module' ? 'esm' : 'cjs'
          const transformed = transformer.transform(source, moduleType)
          const identity = moduleIdentity(path)
          if (identity !== undefined) flushBindings(stateRef, identity)
          return { ...result, source: transformed.code, shortCircuit: true }
        } catch (error) {
          stateRef.pending.clear()
          stateRef.transformers.delete(url)
          throw new Error(`stent: failed to transform ${url}`, { cause: error })
        }
      },
    })
  }

  // CommonJS files reached through plain require() (not via the ESM graph)
  // do not pass through the load hook; transform them at compile time. The
  // wrapper is installed once per process and consults the active-installation
  // stack, so concurrent installations never overwrite each other's patch and
  // the disposer needs no restoration.
  installCompileWrapper()

  return () => {
    state.active = false
    const index = states.indexOf(state)
    if (index >= 0) states.splice(index, 1)
    for (const transformer of state.transformers.values()) transformer?.free()
    state.transformers.clear()
    writeAsyncConfig()
  }
}

/** Whether the singleton CJS `_compile` wrapper is installed. */
let compileWrapperInstalled = false

/**
 * Install the process-wide `_compile` wrapper once. With no active
 * installation it passes through to the original compile function; with one
 * or more it chains the content through every active installation's matcher
 * in installation order, mirroring the sync ESM hook chain (a later
 * installation's transform applies last, wrapping outermost). Disposed
 * installations are spliced out of the stack and skipped.
 */
function installCompileWrapper(): void {
  if (compileWrapperInstalled) return
  compileWrapperInstalled = true
  const modulePrototype = Module.prototype as unknown as Record<string, unknown>
  const compileKey = '_compile'
  const originalCompile = modulePrototype[compileKey] as CompileFn
  modulePrototype[compileKey] = function (this: Module, content: string, filename: string) {
    const identity = moduleIdentity(filename)
    if (identity !== undefined) {
      for (const state of states) {
        if (!state.active) continue
        const transformer = state.matcher.getTransformer(identity.name, identity.version, identity.path)
        if (!transformer || state.seen.has(filename)) continue
        state.seen.add(filename)
        try {
          content = transformer.transform(content, 'cjs').code
          flushBindings(state, identity)
        } catch (error) {
          state.pending.clear()
          state.seen.delete(filename)
          throw new Error(`stent: failed to transform ${filename}`, { cause: error })
        }
      }
    }
    return originalCompile.call(this, content, filename)
  }
}

/**
 * Resolve the source text of a module being loaded.
 * @param result - the load-hook result.
 * @param url - the module URL, used to read CommonJS sources Node leaves null.
 * @returns the source string.
 */
function readSource(
  result: { source?: string | ArrayBuffer | NodeJS.TypedArray | null | undefined },
  url: string,
): string {
  if (typeof result.source === 'string') return result.source
  if (result.source instanceof ArrayBuffer) return Buffer.from(new Uint8Array(result.source)).toString('utf8')
  if (result.source != null) return Buffer.from(result.source as Uint8Array).toString('utf8')
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
 * invalidation the vendored Loader's HMR performs), so both graphs observe
 * the fresh evaluation. The returned value is the NEW module exports object;
 * references to the old one keep the old transformation.
 * @param filename - the absolute module path used as the `require.cache` key.
 * @returns the freshly evaluated module exports.
 */
export function retransformCommonJs(filename: string): unknown {
  return reloadCommonJs(filename, path => {
    for (const state of states) state.seen.delete(path)
  })
}

/**
 * Re-evaluate an already-loaded ESM module under the current instrumentation
 * stack.
 *
 * HMR-style invalidation for ESM: the module's entry in Node's internal
 * `loadCache` is evicted (the same mechanism the vendored Loader's HMR uses)
 * and the `seen` marks are cleared, so the next `import()` of the same URL
 * re-evaluates the module and the load hooks transform it with the
 * top-of-stack installation's current matcher. The returned value is the NEW
 * module namespace; references to the old one keep the old transformation.
 *
 * A failed re-import restores the evicted cache entry (the same rollback the
 * vendored Loader's HMR performs): the module falls back to the previous
 * instance instead of being left unevaluatable, and a later `import()` of the
 * URL serves the restored instance without re-evaluating it.
 *
 * Requires the Node internal loader (Node >= 22) and the synchronous
 * `registerHooks` path — the async `module.register` fallback transforms ESM
 * in the loader thread, where a main-thread eviction alone does not reach.
 * @param url - the module URL used as the `loadCache` key.
 * @returns the freshly evaluated module namespace.
 */
export async function retransformEsm(url: string): Promise<Record<string, unknown>> {
  return reloadEsm(url, path => {
    for (const state of states) state.seen.delete(path)
  })
}
