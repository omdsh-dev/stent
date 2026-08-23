/**
 * Cordis Stent API: the cooperative compat facade over the pure
 * `stent` registry.
 *
 * The package exposes the patch-backed gap adapter for target domains with
 * no cooperative extension point: `StentCompatService` (register, observe,
 * serve bundles) plus the load-time instrumentation builder. Host-specific
 * integrations live in the companion integration package; this package
 * depends only on Cordis and `stent`.
 * @module @oh-my-dsh/stent-api
 */

export { buildCompatInstrumentations } from './compat/instrumentation.ts'
export { StentCompatService } from './compat/service.ts'
export type { StentCompatConfig, StentCompatPatch, StentCompatTarget } from './compat/types.ts'
