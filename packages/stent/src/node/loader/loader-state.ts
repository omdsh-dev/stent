import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
  loadedEsmUrls,
} from '../../hmr/reload.ts'
import { runtime } from '../../runtime.ts'
import {
  expandPatchStub,
  type StentInstrumentationConfig,
} from '../../transform/config.ts'
import {
  resolvePackageIdentity,
  type PackageIdentity,
} from '../../transform/identity.ts'
import {
  createStentMatcher,
  getStentTransformer,
  orderStentInstrumentations,
  type StentMatcher,
} from '../../transform/matcher.ts'
import type { StentPatchInfo, StentPatchStub, PatchId } from '../../types.ts'
import type { LoaderState } from './loader-types.ts'

const states: LoaderState[] = []
const nodeRequire = createRequire(import.meta.url)

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

function patchStubFromInfo(info: StentPatchInfo): StentPatchStub {
  const stub: StentPatchStub = {
    id: info.id,
    target: info.target,
    operation: info.operation,
  }
  if (info.priority !== 0) {
    stub.priority = info.priority
  }
  if (info.required !== undefined) {
    stub.required = info.required
  }
  return stub
}

function patchShapeKey(info: StentPatchInfo): string {
  const target = info.target
  let filePath: string | RegExp | [string, string] | undefined
  if (target.filePath instanceof RegExp) {
    filePath = [target.filePath.source, target.filePath.flags]
  } else {
    filePath = target.filePath
  }
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

function currentInstrumentations(): StentInstrumentationConfig[] {
  return orderStentInstrumentations(
    runtime.list().flatMap((info) => expandPatchStub(patchStubFromInfo(info))),
  )
}

function createMatcher(
  pending: Map<PatchId, number>,
  instrumentations: StentInstrumentationConfig[],
): StentMatcher {
  return createStentMatcher(instrumentations, (patchId) => {
    pending.set(patchId, (pending.get(patchId) ?? 0) + 1)
  })
}

function clearSeen(filename: string): void {
  for (const installation of states) {
    installation.seen.delete(filename)
  }
}

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

function refreshDynamicState(
  state: LoaderState,
  writeConfig: () => void,
): void {
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
  state.matcher = createMatcher(state.pending, state.instrumentations)
  state.pendingPreviousMatchers.push(previousMatcher)
  writeConfig()
  queueLoadedRetransform(state)
}

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

export {
  states,
  flushBindings,
  patchShapeKey,
  currentInstrumentations,
  createMatcher,
  clearSeen,
  refreshDynamicState,
  supportsSyncHooks,
}
