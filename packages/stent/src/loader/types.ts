import type { Module } from 'node:module'

import type { PatchId, StentBinding, StentPatchInfo } from '#src/types'

import type { LoaderState } from './state.ts'

/** The `Module.prototype._compile` function wrapped for CommonJS transforms. */
type CompileFn = (this: Module, content: string, filename: string) => unknown

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

export type { CompileFn, LoaderBindingRecorder, LoaderHost, LoaderPatchReader }
