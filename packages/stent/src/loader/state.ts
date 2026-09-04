import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { expandPatchStub } from '#src/transform/config'
import { resolvePackageIdentity } from '#src/transform/identity'
import {
  createStentMatcher,
  getStentTransformer,
  orderStentInstrumentations,
} from '#src/transform/matcher'
import type { PatchId, StentPatchInfo, StentPatchStub } from '#src/types'

import {
  loadedEsmUrls,
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
} from './reload.ts'
import type { LoaderPatchReader, LoaderState } from './types.ts'

/* Types published by the modules imported above for their functions. */
type StentInstrumentationConfig = ReturnType<typeof expandPatchStub>[number]
type StentMatcher = ReturnType<typeof createStentMatcher>

/* Named literals for empty collections, priorities, and match tallies. */
const EMPTY_SIZE = 0
const DEFAULT_PRIORITY = 0
const NO_MATCHES = 0
const ONE_MATCH = 1
const DRAIN_FROM = 0
const NOT_FOUND_INDEX = -1
const REMOVE_COUNT = 1

const states: LoaderState[] = []
const nodeRequire = createRequire(import.meta.url)

/** Return the states currently visible to the process-wide hook adapters. */
const getStates = (): readonly LoaderState[] => {
  const current = states
  return current
}

/** Add one active installation to the loader state registry. */
const addState = (state: LoaderState): void => {
  states.push(state)
}

/** Whether any registered loader installation is still active. */
const hasActiveState = (): boolean => {
  const current = states
  return current.some((state) => state.active)
}

/** Remove one installation from the loader state registry. */
function removeState(state: LoaderState): void {
  const index = states.indexOf(state)
  if (index !== NOT_FOUND_INDEX) {
    states.splice(index, REMOVE_COUNT)
  }
}

/** Release the mutable buffers held by one disposed installation. */
function clearStateBuffers(state: LoaderState): void {
  state.pending.clear()
  state.seen.clear()
  state.pendingPreviousMatchers.length = EMPTY_SIZE
  state.pendingLoadedModules.clear()
}

/** Reduce one registered patch to the static stub the matcher consumes. */
function patchStubFromInfo(info: StentPatchInfo): StentPatchStub {
  const optional: { priority?: number; required?: boolean } = {}
  if (info.priority !== DEFAULT_PRIORITY) {
    optional.priority = info.priority
  }
  if (info.required !== undefined) {
    optional.required = info.required
  }
  return {
    id: info.id,
    target: info.target,
    operation: info.operation,
    ...optional,
  }
}

/** JSON-friendly file selector that keeps regular expressions distinguishable. */
function filePathKey(
  filePath: string | RegExp | undefined,
): string | [string, string] | undefined {
  if (filePath instanceof RegExp) {
    return [filePath.source, filePath.flags]
  }
  return filePath
}

/** Stable key over everything about a patch the matcher snapshot depends on. */
function patchShapeKey(info: StentPatchInfo): string {
  const { target } = info
  return JSON.stringify([
    info.id,
    target.module,
    target.versionRange,
    filePathKey(target.filePath),
    target.filePaths,
    target.index,
    target.functionQuery,
    target.astQuery,
    info.operation,
    info.priority,
  ])
}

/** Expand every registered patch into an ordered instrumentation snapshot. */
function currentInstrumentations(
  patches: readonly StentPatchInfo[],
): StentInstrumentationConfig[] {
  return orderStentInstrumentations(
    patches.flatMap((info) => expandPatchStub(patchStubFromInfo(info))),
  )
}

/** Create a matcher that tallies every rewritten node under its patch id. */
function createMatcher(
  pending: Map<PatchId, number>,
  instrumentations: StentInstrumentationConfig[],
): StentMatcher {
  return createStentMatcher(instrumentations, (patchId) => {
    pending.set(patchId, (pending.get(patchId) ?? NO_MATCHES) + ONE_MATCH)
  })
}

/** Build the mutable state backing one dynamic installation. */
function createLoaderState(
  syncHooks: boolean,
  listPatches: LoaderPatchReader,
): LoaderState {
  const instrumentations = currentInstrumentations(listPatches())
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

/** Forget one file's transform mark in every installation. */
function clearSeen(filename: string): void {
  for (const installation of states) {
    installation.seen.delete(filename)
  }
}

/** Whether a matcher still selects the module that owns `path`. */
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

/** Re-import every loaded ESM module the given matchers still select. */
async function retransformEsmTargets(
  matchers: readonly StentMatcher[],
  loadedModules: readonly string[],
  cjsPaths: ReadonlySet<string>,
): Promise<void> {
  const esmTargets = loadedModules
    .filter((url) => url.startsWith('file:'))
    .filter((url) => {
      const path = fileURLToPath(url)
      return (
        !cjsPaths.has(path)
        && matchers.some((matcher) => matcherSelects(matcher, url))
      )
    })
  for (const url of esmTargets) {
    await reloadEsm(url, clearSeen)
  }
}

/** Re-evaluate every loaded module the current or retired matchers select. */
async function retransformLoadedTargets(
  state: LoaderState,
  previousMatchers: readonly StentMatcher[],
  loadedModules: readonly string[],
): Promise<void> {
  const matchers = [state.matcher, ...previousMatchers]
  const cjsPaths = loadedModules.filter((path) => !path.startsWith('file:'))
  const cjsTargets = cjsPaths.filter((path) =>
    matchers.some((matcher) => matcherSelects(matcher, path)),
  )
  for (const path of cjsTargets) {
    reloadCommonJs(path, clearSeen)
  }
  if (!state.syncHooks) {
    return
  }
  await retransformEsmTargets(matchers, loadedModules, new Set(cjsPaths))
}

function drainQueuedWork(state: LoaderState): {
  previousMatchers: StentMatcher[]
  loadedModules: string[]
} {
  state.retransformQueued = false
  const previousMatchers = state.pendingPreviousMatchers.splice(DRAIN_FROM)
  const loadedModules = [...state.pendingLoadedModules]
  state.pendingLoadedModules.clear()
  return { previousMatchers, loadedModules }
}

/* One pass: it waits for the previous pass so two never interleave over Node's
   shared module cache; failures become warnings. */
async function runQueuedRetransform(state: LoaderState): Promise<void> {
  const previousPass = state.retransformPass
  const { previousMatchers, loadedModules } = drainQueuedWork(state)
  if (previousPass !== undefined) {
    await previousPass
  }
  if (!state.active) {
    return
  }
  try {
    await retransformLoadedTargets(state, previousMatchers, loadedModules)
  } catch (error: unknown) {
    process.emitWarning(
      `stent: dynamic target re-transformation failed: ${String(error)}`,
    )
  }
}

/** Schedule at most one retransform pass per microtask. */
function queueLoadedRetransform(state: LoaderState): void {
  if (state.retransformQueued) {
    return
  }
  state.retransformQueued = true
  queueMicrotask(() => {
    state.retransformPass = runQueuedRetransform(state)
  })
}

/** Record every currently loaded module for the next retransform pass. */
function collectLoadedModules(state: LoaderState): void {
  for (const path of Object.keys(nodeRequire.cache)) {
    state.pendingLoadedModules.add(path)
  }
  if (state.syncHooks) {
    for (const url of loadedEsmUrls()) {
      state.pendingLoadedModules.add(url)
    }
  }
}

/** Release the transformers cached under the retired matcher snapshot. */
function freeTransformers(state: LoaderState): void {
  for (const transformer of state.transformers.values()) {
    transformer.free()
  }
  state.transformers.clear()
}

/** Rebuild the matcher snapshot after a patch registration changed. */
function refreshDynamicState(
  state: LoaderState,
  writeConfig: () => void,
  listPatches: LoaderPatchReader,
): void {
  const previousMatcher = state.matcher
  collectLoadedModules(state)
  freeTransformers(state)
  state.instrumentations = currentInstrumentations(listPatches())
  state.matcher = createMatcher(state.pending, state.instrumentations)
  state.pendingPreviousMatchers.push(previousMatcher)
  writeConfig()
  queueLoadedRetransform(state)
}

export {
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
}
