import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolvePackageIdentity } from '#src/transform/identity'
import { getStentTransformer } from '#src/transform/matcher'
import type { StentMatcher } from '#src/transform/matcher'
import type { StentPatchInfo } from '#src/types'

import { loaderStates } from './registry.ts'
import {
  loadedEsmUrls,
  retransformCommonJs as reloadCommonJs,
  retransformEsm as reloadEsm,
} from './reload.ts'
import { LoaderState } from './state-owner.ts'
import type { LoaderPatchReader } from './types.ts'

type Matcher = StentMatcher

const nodeRequire = createRequire(import.meta.url)

function filePathKey(
  filePath: string | RegExp | undefined,
): string | [string, string] | undefined {
  if (filePath instanceof RegExp) {
    return [filePath.source, filePath.flags]
  }
  return filePath
}

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

const createLoaderState = (
  syncHooks: boolean,
  listPatches: LoaderPatchReader,
): LoaderState => new LoaderState(syncHooks, listPatches)

function matcherSelects(matcher: Matcher, path: string): boolean {
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

async function retransformEsmTargets(
  state: LoaderState,
  matchers: readonly Matcher[],
  loadedModules: readonly string[],
  cjsPaths: ReadonlySet<string>,
): Promise<void> {
  const esmTargets = loadedModules
    .filter((url) => url.startsWith('file:'))
    .filter((url) => !cjsPaths.has(fileURLToPath(url)))
    .filter((url) => matchers.some((matcher) => matcherSelects(matcher, url)))
  for (const url of esmTargets) {
    if (!state.active) {
      return
    }
    await reloadEsm(url, (filename) => {
      loaderStates.clearSeen(filename)
    })
  }
}

async function retransformLoadedTargets(
  state: LoaderState,
  previousMatchers: readonly Matcher[],
  loadedModules: readonly string[],
): Promise<void> {
  const matchers = [state.matcher, ...previousMatchers]
  const cjsPaths = loadedModules.filter(
    (modulePath) => !modulePath.startsWith('file:'),
  )
  for (const targetPath of cjsPaths.filter((candidatePath) =>
    matchers.some((matcher) => matcherSelects(matcher, candidatePath)),
  )) {
    if (!state.active) {
      return
    }
    reloadCommonJs(targetPath, (filename) => {
      loaderStates.clearSeen(filename)
    })
  }
  if (state.syncHooks) {
    await retransformEsmTargets(
      state,
      matchers,
      loadedModules,
      new Set(cjsPaths),
    )
  }
}

async function runQueuedRetransform(state: LoaderState): Promise<void> {
  const previousPass = state.retransformPass
  const { previousMatchers, loadedModules } = state.takeQueuedWork()
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

function queueLoadedRetransform(state: LoaderState): void {
  if (state.isRetransformQueued()) {
    return
  }
  state.markRetransformQueued()
  queueMicrotask(() => {
    state.retransformPass = runQueuedRetransform(state)
  })
}

function collectLoadedModules(state: LoaderState): void {
  for (const path of Object.keys(nodeRequire.cache)) {
    state.collectLoadedModule(path)
  }
  if (state.syncHooks) {
    for (const url of loadedEsmUrls()) {
      state.collectLoadedModule(url)
    }
  }
}

function refreshDynamicState(
  state: LoaderState,
  writeConfig: () => void,
  listPatches: LoaderPatchReader,
): void {
  if (!state.active) {
    return
  }
  collectLoadedModules(state)
  state.releaseTransformers()
  state.refresh(listPatches)
  writeConfig()
  queueLoadedRetransform(state)
}

export { createLoaderState, patchShapeKey, refreshDynamicState }
export { LoaderState } from './state-owner.ts'
