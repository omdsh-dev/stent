/**
 * Node transformation hooks for Stent. This module owns installation lifecycle;
 * hook implementations and mutable loader state live in adjacent modules.
 *
 * @module @oh-my-dsh/stent/loader
 */

import { installBridge } from '#src/bridge'
import { runtime } from '#src/runtime'

import { installAsyncHooks, writeAsyncConfig } from './async.ts'
import {
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
} from './reload.ts'
import {
  addState,
  clearSeen,
  clearStateBuffers,
  createLoaderState,
  freeTransformers,
  getStates,
  hasActiveState,
  patchShapeKey,
  refreshDynamicState,
  removeState,
} from './state.ts'
import {
  installCompileWrapper,
  installSynchronousHooks,
  supportsSyncHooks,
} from './sync.ts'
import type { LoaderHost, LoaderState } from './types.ts'

/** Size of an empty collection; named for the no-magic-numbers rule. */
const EMPTY_COUNT = 0
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

const loaderHost: LoaderHost = {
  getStates,
  listPatches: () => runtime.list(),
  recordBindings: (id, records) => {
    runtime.recordBindings(id, records)
  },
}

/** Choose the hook flavour this process supports, booting the loader thread. */
function prepareHookThread(): boolean {
  const syncHooks = supportsSyncHooks()
  if (!syncHooks) {
    installAsyncHooks(import.meta.url, loaderHost)
  }
  return syncHooks
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
    refreshDynamicState(state, writeAsyncConfig, loaderHost.listPatches)
  })
  if (state.syncHooks) {
    installSynchronousHooks(state, loaderHost)
  } else {
    writeAsyncConfig()
  }
  installCompileWrapper(loaderHost)
  return unsubscribePatchChanges
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
  if (hasActiveState()) {
    throw new Error(
      'stent: installStentHooks allows only one active dynamic installation',
    )
  }
  installBridge()
  const state = createLoaderState(prepareHookThread(), loaderHost.listPatches)
  addState(state)
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

export { flushBindingReports } from './async.ts'

export {
  checkRequiredPatches,
  installStentHooks,
  retransformCommonJs,
  retransformEsm,
}
