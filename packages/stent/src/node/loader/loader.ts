/**
 * Node transformation hooks for Stent. This module owns installation lifecycle;
 * hook implementations and mutable loader state live in adjacent modules.
 *
 * @module @oh-my-dsh/stent/node/internal-loader
 */

import { installBridge } from '#src/bridge'
import {
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
} from '#src/hmr/reload'
import { runtime } from '#src/runtime'

import { installAsyncHooks, writeAsyncConfig } from './loader-async.ts'
import {
  clearSeen,
  createMatcher,
  currentInstrumentations,
  patchShapeKey,
  refreshDynamicState,
  states,
  supportsSyncHooks,
} from './loader-state.ts'
import {
  installCompileWrapper,
  installSynchronousHooks,
} from './loader-sync.ts'
import type { LoaderState } from './loader-types.ts'

/** Size of an empty collection; named for the no-magic-numbers rule. */
const EMPTY_COUNT = 0
/** Result of `indexOf` when the searched value is absent. */
const NOT_FOUND_INDEX = -1
/** Number of entries removed when one installation is dropped. */
const REMOVE_COUNT = 1

/** Describe every required patch that bound no target at load time. */
function missingRequiredPatches(): string[] {
  const missing: string[] = []
  for (const patch of runtime.list()) {
    if (
      patch.required === true
      && runtime.bindingsOf(patch.id).length === EMPTY_COUNT
    ) {
      missing.push(
        `${patch.id} (${patch.target.module} ${String(patch.target.filePath)}, ${patch.operation})`,
      )
    }
  }
  return missing
}

/** Verify that every required patch recorded at least one load-time binding. */
function checkRequiredPatches(): void {
  const missing = missingRequiredPatches()
  if (missing.length > EMPTY_COUNT) {
    throw new Error(
      'stent: required patch(es) bound nothing at load time; the target file may be the wrong '
        + `launch form (src vs lib) or the function may have moved: ${missing.join('; ')}`,
    )
  }
}

/** Whether a dynamic installation is already active in this process. */
function hasActiveInstallation(): boolean {
  for (const state of states) {
    if (state.active) {
      return true
    }
  }
  return false
}

/** Choose the hook flavour this process supports, booting the loader thread. */
function prepareHookThread(): boolean {
  const syncHooks = supportsSyncHooks()
  if (!syncHooks) {
    installAsyncHooks(import.meta.url)
  }
  return syncHooks
}

/** Build the mutable state backing one dynamic installation. */
function createLoaderState(syncHooks: boolean): LoaderState {
  const instrumentations = currentInstrumentations()
  const pending: LoaderState['pending'] = new Map()
  return {
    active: true,
    matcher: createMatcher(pending, instrumentations),
    instrumentations,
    syncHooks,
    transformers: new Map(),
    seen: new Set(),
    pending,
    pendingPreviousMatchers: [],
    pendingLoadedModules: new Set(),
    retransformQueued: false,
    retransformPass: undefined,
  }
}

/** Subscribe to patch changes and install the hooks this state uses. */
function activateHooks(state: LoaderState): () => void {
  const unsubscribePatchChanges = runtime.onPatchChange((change) => {
    if (
      change.type === 'register'
      && change.previous !== undefined
      && change.current !== undefined
      && patchShapeKey(change.previous) === patchShapeKey(change.current)
    ) {
      return
    }
    refreshDynamicState(state, writeAsyncConfig)
  })
  if (state.syncHooks) {
    installSynchronousHooks(state)
  } else {
    writeAsyncConfig()
  }
  installCompileWrapper()
  return unsubscribePatchChanges
}

/** Release the buffers one disposed installation accumulated. */
function clearStateBuffers(state: LoaderState): void {
  state.pending.clear()
  state.seen.clear()
  state.pendingPreviousMatchers.length = EMPTY_COUNT
  state.pendingLoadedModules.clear()
}

/** Drop one installation from the shared installation list. */
function removeState(state: LoaderState): void {
  const index = states.indexOf(state)
  if (index !== NOT_FOUND_INDEX) {
    states.splice(index, REMOVE_COUNT)
  }
}

/** Free every transformer one installation cached. */
function freeTransformers(state: LoaderState): void {
  for (const transformer of state.transformers.values()) {
    transformer.free()
  }
  state.transformers.clear()
}

/** Tear down one dynamic installation and republish the loader config. */
function disposeInstallation(
  state: LoaderState,
  unsubscribePatchChanges: () => void,
): void {
  state.active = false
  unsubscribePatchChanges()
  clearStateBuffers(state)
  removeState(state)
  freeTransformers(state)
  writeAsyncConfig()
}

/** Install the process-wide dynamic Stent transformation hooks and bridge. */
function installStentHooks(): () => void {
  if (arguments.length > EMPTY_COUNT) {
    throw new Error(
      'stent: installStentHooks does not accept arguments; use installStentHooks()',
    )
  }
  if (hasActiveInstallation()) {
    throw new Error(
      'stent: installStentHooks allows only one active dynamic installation',
    )
  }
  installBridge()
  const state = createLoaderState(prepareHookThread())
  states.push(state)
  const unsubscribePatchChanges = activateHooks(state)
  return () => {
    disposeInstallation(state, unsubscribePatchChanges)
  }
}

/** One module reload operation supplied by the HMR implementation. */
type ReloadOperation<Result> = (
  target: string,
  clearSeen: (filename: string) => void,
) => Result

/** One reload target and the operation that knows how to evict it. */
interface ReloadRequest<Result> {
  readonly reload: ReloadOperation<Result>
  readonly target: string
}

/** Run a module reload with the loader's current seen-state cleanup. */
function runRetransform<Result>(request: ReloadRequest<Result>): Result {
  const { reload } = request
  const { target } = request
  return reload(target, clearSeen)
}

/** Re-evaluate an already-loaded CommonJS module under the current matcher. */
function retransformCommonJs(filename: string): unknown {
  const reloaded = runRetransform({
    reload: reloadCommonJs,
    target: filename,
  })
  return reloaded
}

/** Re-evaluate an already-loaded ESM module under the current matcher. */
async function retransformEsm(url: string): Promise<Record<string, unknown>> {
  const reloaded = await runRetransform({
    reload: reloadEsm,
    target: url,
  })
  return reloaded
}

export { flushBindingReports } from './loader-async.ts'

export {
  checkRequiredPatches,
  installStentHooks,
  retransformCommonJs,
  retransformEsm,
}
