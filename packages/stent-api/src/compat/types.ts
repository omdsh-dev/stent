import type { PatchId, StentOperation, StentTarget } from '@oh-my-dsh/stent'

/**
 * Patch metadata for one compat target; the handler is bound by the runtime
 * registry.
 */
interface StentCompatPatch {
  /** Patch id; must be stable for runtime registration and HMR ownership. */
  readonly id: PatchId
  /** Target descriptor: module, version range, file path, and function selector. */
  readonly target: StentTarget
  /** Behavior kind of the underlying patch. */
  readonly operation: StentOperation
}

/** One declared observation target: a stable name for a low-level patch. */
interface StentCompatTarget {
  /** Stable name callers pass to {@link StentCompatService.observe}. */
  readonly name: string
  /** The low-level patch behind this observation. */
  readonly patch: StentCompatPatch
}

/** Module configuration: the declared observation targets. */
interface StentCompatConfig {
  /**
   * Declared targets; an empty or absent list is valid (the service still
   * checks installation).
   */
  readonly targets?: readonly StentCompatTarget[]
}

export type { StentCompatPatch, StentCompatTarget, StentCompatConfig }
