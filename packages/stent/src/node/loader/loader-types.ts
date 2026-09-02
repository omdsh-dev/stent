import type { Module } from 'node:module'

import type { StentInstrumentationConfig } from '#src/transform/config'
import type { StentMatcher, StentTransformer } from '#src/transform/matcher'
import type { PatchId } from '#src/types'

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

export type { CompileFn, LoaderState }
