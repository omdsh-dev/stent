import type { Module } from 'node:module'

import type { StentInstrumentationConfig } from '../../transform/config.ts'
import type { StentMatcher, StentTransformer } from '../../transform/matcher.ts'
import type { PatchId } from '../../types.ts'

/** The `Module.prototype._compile` function wrapped for CommonJS transforms. */
export type CompileFn = (
  this: Module,
  content: string,
  filename: string,
) => unknown

/** Mutable state belonging to one installed loader. */
export interface LoaderState {
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
}
