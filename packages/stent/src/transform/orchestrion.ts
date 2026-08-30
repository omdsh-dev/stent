/**
 * The only direct adapter boundary to the Orchestrion code transformer. Runtime
 * and platform adapters consume these local names instead of reaching into the
 * third-party package themselves.
 *
 * @module @oh-my-dsh/stent/transform/orchestrion
 */

import { create as createOrchestrion } from '@apm-js-collab/code-transformer'

/**
 * Create the upstream matcher from upstream-compatible instrumentation configs.
 * Direct callers own this matcher and may call `free()`; the current
 * Node/browser adapters retain their matcher snapshots and do not call
 * `matcher.free()`.
 */
export { createOrchestrion }

/** Upstream matcher and transformer types used behind this adapter boundary. */
export type {
  InstrumentationConfig,
  InstrumentationMatcher,
  Transformer,
} from '@apm-js-collab/code-transformer'
