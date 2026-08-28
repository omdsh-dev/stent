/**
 * Node transformation hooks for Stent. This module owns installation lifecycle;
 * hook implementations and mutable loader state live in adjacent modules.
 *
 * @module @oh-my-dsh/stent/node/internal-loader
 */

import { installBridge } from '../bridge.ts'
import {
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
} from '../hmr/reload.ts'
import { runtime } from '../runtime.ts'
import {
  flushBindingReports,
  installAsyncHooks,
  writeAsyncConfig,
} from './loader-async.ts'
import {
  clearSeen,
  createMatcher,
  currentInstrumentations,
  patchShapeKey,
  patchStubFromInfo,
  refreshDynamicState,
  states,
  supportsSyncHooks,
} from './loader-state.ts'
import {
  installCompileWrapper,
  installSynchronousHooks,
} from './loader-sync.ts'
import type { LoaderState } from './loader-types.ts'

/** Verify that every required patch recorded at least one load-time binding. */
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

/** Install the process-wide dynamic Stent transformation hooks and bridge. */
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
    installAsyncHooks(import.meta.url)
  }

  const state: LoaderState = {
    active: true,
    matcher: undefined as unknown as LoaderState['matcher'],
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
    refreshDynamicState(state, writeAsyncConfig)
  })
  if (!syncHooks) {
    writeAsyncConfig()
  }
  if (syncHooks) {
    installSynchronousHooks(state)
  }
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

/** Re-evaluate an already-loaded CommonJS module under the current matcher. */
// oxlint-disable-next-line stent/min-function-lines -- HMR adapter delegates to shared reload logic.
export function retransformCommonJs(filename: string): unknown {
  return reloadCommonJs(filename, clearSeen)
}

/** Re-evaluate an already-loaded ESM module under the current matcher. */
export async function retransformEsm(
  url: string,
): Promise<Record<string, unknown>> {
  return reloadEsm(url, clearSeen)
}

export { flushBindingReports }
