import type { StentOperation, StentTarget, PatchId } from '@oh-my-dsh/stent'

/** Static patch descriptor of one compat target (the handler is bound at runtime). */
export interface StentCompatPatch {
  /** Patch id; must be stable and match the instrumentation installed at bootstrap. */
  readonly id: PatchId
  /** Target descriptor: module, version range, file path, and function selector. */
  readonly target: StentTarget
  /** Behavior kind of the underlying patch. */
  readonly operation: StentOperation
}

/** One declared observation target: a stable name for a low-level patch. */
export interface StentCompatTarget {
  /** Stable name callers pass to {@link StentCompatService.observe}. */
  readonly name: string
  /** The low-level patch behind this observation. */
  readonly patch: StentCompatPatch
}

/** Module configuration: the declared observation targets. */
export interface StentCompatConfig {
  /** Declared targets; an empty or absent list is valid (the service still checks installation). */
  readonly targets?: readonly StentCompatTarget[]
}
