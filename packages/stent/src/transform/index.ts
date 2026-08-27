/**
 * Unified export for the self-contained Stent transformation layer.
 *
 * This boundary re-exports only the symbols the package actually consumes
 * outside the transform layer (Node loader, browser entries, runtime bridge,
 * and the package's public type surface). Implementation-only symbols stay in
 * their owning modules: the Orchestrion adapter boundary (`./orchestrion.ts`),
 * the custom-transform registration (`./transform.ts`), the instrumentation
 * ordering helper (`./config.ts`), and the module-type detector
 * (`./identity.ts`) remain reachable only from their internal consumers.
 *
 * @module @oh-my-dsh/stent/transform
 */

export {
  createBrowserTransform,
  createInstrumentedTransform,
  createWatchedBrowserTransform,
  repoSourceResolver,
} from './browser.ts'
export type {
  BrowserTransform,
  BrowserTransformOptions,
  IdentityResolver,
  ModuleIdentity,
  RepoSourceResolverOptions,
  TransformOutput,
  WatchedBrowserTransform,
  WatchedBrowserTransformOptions,
} from './browser.ts'
export { expandPatchStub } from './config.ts'
export type { StentInstrumentationConfig } from './config.ts'
export { resolvePackageIdentity } from './identity.ts'
export type { PackageIdentity } from './identity.ts'
export {
  createStentMatcher,
  getStentTransformer,
  orderStentInstrumentations,
  transformStentSource,
} from './matcher.ts'
export type { StentMatcher, StentTransformer } from './matcher.ts'
export { GLOBAL_BRIDGE_KEY } from './protocol.ts'
export { validatePatchId, validatePatchStatic } from './validation.ts'
export type {
  PatchId,
  StentBinding,
  StentBindingReport,
  StentFunctionKind,
  StentFunctionQuery,
  StentOperation,
  StentPatchStub,
  StentTarget,
} from './types.ts'
export { reviveInstrumentation, serializeInstrumentation } from './wire.ts'
export type { StentWireInstrumentation } from './wire.ts'
