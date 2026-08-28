/**
 * The only direct adapter boundary to the Orchestrion code transformer. Runtime
 * and platform adapters consume these local names instead of reaching into the
 * third-party package themselves.
 *
 * @module @oh-my-dsh/stent/transform/orchestrion
 */

import { create as createOrchestrion } from '@apm-js-collab/code-transformer'

export { createOrchestrion }
export type {
  InstrumentationConfig,
  InstrumentationMatcher,
  Transformer,
} from '@apm-js-collab/code-transformer'
