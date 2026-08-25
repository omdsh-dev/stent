/**
 * Cordis Stent service: the runtime face of the experimental Stent/Mixin
 * extension layer. Trusted plugins register patches (target + operation +
 * handler) here; the transformation hooks installed by
 * {@link installStentHooks} rewrite the target functions, and this service
 * attaches and detaches the handlers in the shared runtime.
 *
 * The service is opt-in: nothing in the default host composition mounts it,
 * and a plugin only receives `ctx.stent` when it declares the service and the
 * runtime entered through the Stent DSH launch path.
 * @module @oh-my-dsh/stent
 */

export { STENT_DSH_LAUNCH_KEY, isStentDshLaunch, markStentDshLaunch } from './activation.ts'
export { GLOBAL_BRIDGE_KEY, installBridge, isStentInstalled, publish, type StentBridgeCall } from './bridge.ts'
export {
  checkRequiredPatches,
  expandPatchStub,
  flushBindingReports,
  installStentHooks,
  patchInstrumentation,
  retransformCommonJs,
  retransformEsm,
  type StentInstrumentationConfig,
  type InstrumentationConfig,
} from './node/loader.ts'
export {
  createBrowserTransform,
  createWatchedBrowserTransform,
  nodeModulesResolver,
  nodePackageResolver,
  repoSourceResolver,
  type IdentityResolver,
  type ModuleIdentity,
  type TransformOutput,
  type WatchedBrowserTransform,
} from './browser/transform.ts'
export { runtime, validatePatchId, validatePatchStatic } from './runtime.ts'
export { serveBrowserTransform, type ServeBrowserTransformOptions } from './browser/serve.ts'
export { createStentTransform } from './transform/transform.ts'
export type {
  StentAfterHandler,
  StentAroundHandler,
  StentBeforeHandler,
  StentBinding,
  StentBindingReport,
  StentCall,
  StentHandler,
  StentInvoke,
  StentOperation,
  StentPatch,
  StentPatchInfo,
  StentPatchStub,
  StentReplaceHandler,
  StentTarget,
  PatchId,
} from './types.ts'

export { StentService, getStent } from './service.ts'
