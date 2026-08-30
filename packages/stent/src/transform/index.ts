/**
 * Source-only convenience barrel for the self-contained Stent transformation
 * layer.
 *
 * This file is not a published package entry: `packages/stent/package.json`
 * does not expose `./transform`, and the build has no `transform/index.ts`
 * artifact. It collects the symbols used by package-internal consumers with
 * explicit export lists; implementation-only Orchestrion and AST helpers stay
 * private to their owning modules. Public callers use
 * `@oh-my-dsh/stent/browser` or the package root instead.
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
