import { expandPatchStub } from '#src/transform/config'
import type { StentInstrumentationConfig } from '#src/transform/config'
import {
  createStentMatcher,
  orderStentInstrumentations,
} from '#src/transform/matcher'
import type { StentMatcher, StentTransformer } from '#src/transform/matcher'
import type { PatchId, StentPatchInfo, StentPatchStub } from '#src/types'

import type { LoaderPatchReader } from './types.ts'

type StentInstrumentation = StentInstrumentationConfig
type Matcher = StentMatcher

const DEFAULT_PRIORITY = 0
const NO_MATCHES = 0
const ONE_MATCH = 1
const DRAIN_FROM = 0

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

function currentInstrumentations(
  patches: readonly StentPatchInfo[],
): StentInstrumentation[] {
  return orderStentInstrumentations(
    patches.flatMap((info) => expandPatchStub(patchStubFromInfo(info))),
  )
}

/** Owns all mutable state for one installed Node transformation hook. */
class LoaderState {
  #active = true
  #matcher: Matcher
  #instrumentations: StentInstrumentation[]
  readonly #syncHooks: boolean
  readonly #transformers = new Map<string, StentTransformer>()
  readonly #seen = new Set<string>()
  readonly #pending = new Map<PatchId, number>()
  readonly #previousMatchers: Matcher[] = []
  readonly #loadedModules = new Set<string>()
  #retransformQueued = false
  #retransformPass: Promise<void> | undefined

  public constructor(syncHooks: boolean, listPatches: LoaderPatchReader) {
    this.#syncHooks = syncHooks
    this.#instrumentations = currentInstrumentations(listPatches())
    this.#matcher = this.createMatcher(this.#instrumentations)
  }

  public get active(): boolean {
    return this.#active
  }
  public get matcher(): Matcher {
    return this.#matcher
  }
  public get instrumentations(): readonly StentInstrumentation[] {
    return [...this.#instrumentations]
  }
  public get syncHooks(): boolean {
    return this.#syncHooks
  }

  public recordMatch(patchId: PatchId): void {
    this.runIfActive(() => {
      this.#pending.set(
        patchId,
        (this.#pending.get(patchId) ?? NO_MATCHES) + ONE_MATCH,
      )
    })
  }
  public pendingEntries(): readonly (readonly [PatchId, number])[] {
    return [...this.#pending.entries()]
  }
  public clearPending(): void {
    this.#pending.clear()
  }
  public hasSeen(path: string): boolean {
    return this.#seen.has(path)
  }
  public markSeen(path: string): void {
    this.runIfActive(() => {
      this.#seen.add(path)
    })
  }
  public clearSeen(path: string): void {
    this.runIfActive(() => {
      this.#seen.delete(path)
    })
  }
  public transformerFor(url: string): StentTransformer | undefined {
    if (!this.#active) {
      return undefined
    }
    return this.#transformers.get(url)
  }
  public rememberTransformer(url: string, transformer: StentTransformer): void {
    this.runIfActive(() => {
      this.#transformers.set(url, transformer)
    })
  }
  public forgetTransformer(url: string): void {
    this.runIfActive(() => {
      this.#transformers.delete(url)
    })
  }
  public releaseTransformers(): void {
    for (const transformer of this.#transformers.values()) {
      transformer.free()
    }
    this.#transformers.clear()
  }
  public collectLoadedModule(path: string): void {
    this.runIfActive(() => {
      this.#loadedModules.add(path)
    })
  }
  public queuePreviousMatcher(matcher: Matcher): void {
    this.runIfActive(() => {
      this.#previousMatchers.push(matcher)
    })
  }
  public takeQueuedWork(): {
    previousMatchers: Matcher[]
    loadedModules: string[]
  } {
    if (!this.#active) {
      return { previousMatchers: [], loadedModules: [] }
    }
    this.#retransformQueued = false
    const previousMatchers = this.#previousMatchers.splice(DRAIN_FROM)
    const loadedModules = [...this.#loadedModules]
    this.#loadedModules.clear()
    return { previousMatchers, loadedModules }
  }
  public isRetransformQueued(): boolean {
    return this.#retransformQueued
  }
  public markRetransformQueued(): void {
    this.runIfActive(() => {
      this.#retransformQueued = true
    })
  }
  public get retransformPass(): Promise<void> | undefined {
    return this.#retransformPass
  }
  public set retransformPass(pass: Promise<void> | undefined) {
    if (!this.#active) {
      return
    }
    this.#retransformPass = pass
  }
  public refresh(listPatches: LoaderPatchReader): void {
    if (!this.#active) {
      return
    }
    const previousMatcher = this.#matcher
    this.#instrumentations = currentInstrumentations(listPatches())
    this.#matcher = this.createMatcher(this.#instrumentations)
    this.queuePreviousMatcher(previousMatcher)
  }
  public dispose(): void {
    if (!this.#active) {
      return
    }
    this.#active = false
    this.#pending.clear()
    this.#seen.clear()
    this.#previousMatchers.splice(DRAIN_FROM)
    this.#loadedModules.clear()
    this.#instrumentations = []
    this.#retransformQueued = false
    this.#retransformPass = undefined
    this.releaseTransformers()
  }
  private runIfActive(action: () => void): void {
    if (this.#active) {
      action()
    }
  }

  private createMatcher(instrumentations: StentInstrumentation[]): Matcher {
    return createStentMatcher(instrumentations, (patchId) => {
      this.recordMatch(patchId)
    })
  }
}

export { LoaderState }
