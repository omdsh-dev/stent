import type { Module } from 'node:module'

import type { StentInstrumentationConfig } from '#src/transform/config'
import type { StentMatcher, StentTransformer } from '#src/transform/matcher'
import type { PatchId, StentBinding, StentPatchInfo } from '#src/types'

/** The `Module.prototype._compile` function wrapped for CommonJS transforms. */
type CompileFn = (this: Module, content: string, filename: string) => unknown

/** Mutable state belonging to one installed loader. */
interface LoaderState {
  active: boolean
  matcher: StentMatcher
  instrumentations: StentInstrumentationConfig[]
  syncHooks: boolean
  transformers: Map<string, StentTransformer>
  seen: Set<string>
  pending: Map<PatchId, number>
  pendingPreviousMatchers: StentMatcher[]
  pendingLoadedModules: Set<string>
  retransformQueued: boolean
  /**
   * The in-flight retransform pass; the next pass awaits it so passes never
   * overlap.
   */
  retransformPass: Promise<void> | undefined
}

/** Read the active states used by process-wide Node hook adapters. */
type LoaderStateReader = () => readonly LoaderState[]

/** Read the patch metadata used to build a matcher snapshot. */
type LoaderPatchReader = () => readonly StentPatchInfo[]

/** Record binding reports received from a hook adapter. */
type LoaderBindingRecorder = (
  id: PatchId,
  records: readonly StentBinding[],
) => void

/** Host services supplied by the central loader to its hook adapters. */
interface LoaderHost {
  readonly getStates: LoaderStateReader
  readonly listPatches: LoaderPatchReader
  readonly recordBindings: LoaderBindingRecorder
}

export type {
  CompileFn,
  LoaderBindingRecorder,
  LoaderHost,
  LoaderPatchReader,
  LoaderState,
}
