/**
 * Orchestrion matcher operations shared by the Node and browser adapters.
 * Matcher creation, module lookup, and source transformation are centralized
 * here. The upstream types expose `free()`, but current adapters keep each
 * matcher for its adapter lifetime; the Node loader frees selected transformers
 * it tracks when a snapshot changes or is disposed, while browser factories
 * have no explicit disposer.
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

/** Upstream matcher with the Stent custom transform registered. */
type StentMatcher = InstrumentationMatcher

/** Upstream module transformer; it exposes `transform()` and `free()`. */
type StentTransformer = Transformer

/**
 * Order an instrumentation snapshot for the Orchestrion matcher and wire.
 *
 * @param instrumentations - Expanded configs to copy and sort.
 * @returns A new ascending-priority array.
 */
function orderStentInstrumentations(
  instrumentations: readonly StentInstrumentationConfig[],
): StentInstrumentationConfig[] {
  return orderInstrumentations(instrumentations)
}

/**
 * Create a matcher from an instrumentation snapshot and register `'stent'`.
 *
 * @param instrumentations - Expanded configs; copied and ordered before
 *   creation.
 * @param onMatch - Optional callback once per successfully rewritten AST node
 *   during source transformation.
 * @returns A matcher with the Stent transform installed. Direct callers may
 *   call upstream `free()`; current adapters retain their matcher snapshot as
 *   described in the module documentation.
 */
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

/**
 * Select a transformer for a package identity, or return `undefined` on no
 * match.
 *
 * @param matcher - Matcher created by {@link createStentMatcher}.
 * @param moduleName - Resolved package name.
 * @param version - Resolved package version.
 * @param filePath - Package-relative path.
 * @returns The upstream transformer, or `undefined`; direct callers may free
 *   it, while the Node loader retains its cached transformers until snapshot
 *   cleanup.
 */
function getStentTransformer(
  matcher: StentMatcher,
  moduleName: string,
  version: string,
  filePath: string,
): StentTransformer | undefined {
  return matcher.getTransformer(moduleName, version, filePath)
}

/**
 * Transform source with a selected upstream transformer.
 *
 * @param transformer - Transformer selected for the current module.
 * @param source - JavaScript source; TypeScript must be emitted first.
 * @param moduleType - Module format passed to Orchestrion.
 * @returns Rewritten source and an optional source map.
 * @throws When called, propagates parser, selector, and injection errors from
 *   Orchestrion.
 */
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
