/**
 * Orchestrion matcher operations shared by the Node and browser adapters. All
 * creation, lookup, transform, and disposal calls into the third-party matcher
 * stay in this module.
 *
 * @module @oh-my-dsh/stent/transform/matcher
 */

import {
  orderInstrumentations,
  type StentInstrumentationConfig,
} from './config.ts'
import {
  createOrchestrion,
  type InstrumentationMatcher,
  type Transformer,
} from './orchestrion.ts'
import { registerStentTransform } from './transform.ts'

/** Matcher with the Stent custom transform registered. */
type StentMatcher = InstrumentationMatcher

/** Transformer selected for one matching module. */
type StentTransformer = Transformer

/** Order an instrumentation snapshot for the Orchestrion matcher and wire. */
function orderStentInstrumentations(
  instrumentations: readonly StentInstrumentationConfig[],
): StentInstrumentationConfig[] {
  return orderInstrumentations(instrumentations)
}

/** Build a matcher from one ordered instrumentation snapshot. */
function createStentMatcher(
  instrumentations: readonly StentInstrumentationConfig[],
  onMatch?: (patchId: string) => void,
): StentMatcher {
  const matcher = createOrchestrion(
    orderStentInstrumentations(instrumentations),
  )
  registerStentTransform(matcher, onMatch)
  return matcher
}

/** Select a transformer for a package identity, or return undefined on no match. */
function getStentTransformer(
  matcher: StentMatcher,
  moduleName: string,
  version: string,
  filePath: string,
): StentTransformer | undefined {
  return matcher.getTransformer(moduleName, version, filePath)
}

/** Transform source with a selected module transformer. */
function transformStentSource(
  transformer: StentTransformer,
  source: string,
  moduleType: 'esm' | 'cjs',
): { code: string; map?: string } {
  const result = transformer.transform(source, moduleType)
  return result.map === undefined
    ? { code: result.code }
    : { code: result.code, map: result.map }
}

export {
  orderStentInstrumentations,
  createStentMatcher,
  getStentTransformer,
  transformStentSource,
}
export type { StentMatcher, StentTransformer }
