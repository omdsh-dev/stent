/**
 * Cordis Stent service and platform-free runtime API.
 *
 * Node hook installation lives under `@oh-my-dsh/stent/loader`; browser build
 * and bundle-serving APIs live under `@oh-my-dsh/stent/browser`. Keeping those
 * platform boundaries out of this entry also keeps Orchestrion implementation
 * details private to the transform layer.
 *
 * The service is opt-in: nothing in the default host composition mounts it, and
 * a plugin only receives `ctx.stent` when it declares the service and the
 * runtime entered through the Stent DSH launch path.
 *
 * @module @oh-my-dsh/stent
 */

export {
  STENT_DSH_LAUNCH_KEY,
  isStentDshLaunch,
  markStentDshLaunch,
} from './activation.ts'
export {
  GLOBAL_BRIDGE_KEY,
  installBridge,
  isStentInstalled,
  publish,
  type StentBridgeCall,
} from './bridge.ts'
export {
  runtime,
  validatePatchId,
  validatePatchStatic,
  type StentPatchChange,
  type StentPatchChangeListener,
} from './runtime.ts'
export type {
  StentAfterHandler,
  StentAroundHandler,
  StentBeforeHandler,
  StentBinding,
  StentBindingReport,
  StentCall,
  StentFunctionKind,
  StentFunctionQuery,
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
