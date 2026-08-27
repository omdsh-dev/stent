/**
 * Stent descriptor, operation, and handler contracts shared by the Cordis
 * service, the runtime bridge, and the Node transformation hooks.
 *
 * @module @oh-my-dsh/stent/types
 */

import type {
  PatchId,
  StentBinding,
  StentOperation,
  StentTarget,
} from './transform/types.ts'

export type {
  PatchId,
  StentBinding,
  StentBindingReport,
  StentFunctionKind,
  StentFunctionQuery,
  StentOperation,
  StentPatchStub,
  StentTarget,
} from './transform/types.ts'

/** Runtime call record published to a patch's tracing channel. */
export interface StentCall {
  /** Actual call arguments; subscribers may mutate them in place. */
  arguments: unknown[]
  /** `this` receiver of the original call. */
  self: unknown
  /** Version of the owning package captured at transformation time. */
  moduleVersion?: string
  /** Successful result of the traced body (a thenable for async targets). */
  result?: unknown
}

/**
 * Call the original traced body with the (possibly mutated) call arguments. The
 * returned value is a thenable exactly when the original target is async.
 */
export type StentInvoke = () => unknown

/**
 * `before` handler: observes and rewrites the call arguments. The original body
 * runs with the mutated arguments; the return value is ignored.
 *
 * @param call - The call record whose `arguments` array the handler may mutate.
 */
export type StentBeforeHandler = (call: StentCall) => void

/**
 * `after` handler: observes and rewrites the successful result. May return a
 * replacement value (a promise for async targets) or mutate the call's `result`
 * field in place and return `undefined`.
 *
 * @param call - The call record whose `result` holds the original outcome.
 */
export type StentAfterHandler = (call: StentCall) => unknown

/**
 * `around` handler: decides whether the original body runs and may replace its
 * result. Call `invoke()` to run the original body with the mutated arguments;
 * skip it to veto the original body and supply a result directly.
 *
 * @param call - The call record for this invocation.
 * @param invoke - Runs the original body with the current call arguments.
 */
export type StentAroundHandler = (
  call: StentCall,
  invoke: StentInvoke,
) => unknown

/**
 * `replace` handler: owns the call. `invoke()` still runs the original body
 * with the mutated arguments when the handler chooses to delegate.
 *
 * @param call - The call record for this invocation.
 * @param invoke - Runs the original body with the current call arguments.
 */
export type StentReplaceHandler = (
  call: StentCall,
  invoke: StentInvoke,
) => unknown

/** Dispatcher accepted for every operation kind. */
export type StentHandler =
  | StentBeforeHandler
  | StentAfterHandler
  | StentAroundHandler
  | StentReplaceHandler

/**
 * One registered Stent patch. The handler is trusted code bound at registration
 * time; executable handlers are never deserialized from configuration.
 */
export interface StentPatch {
  /**
   * Id within one Stent runtime. Re-registering an id updates the metadata and
   * reports not-first; the first registration's fiber effect still owns
   * disposal.
   */
  id: PatchId
  /** The module, file, and function this patch transforms. */
  target: StentTarget
  /** Behavior kind of this patch. */
  operation: StentOperation
  /**
   * Load-time contract: when true, the bootstrap must observe at least one
   * transformed file for this patch after the application boots. A required
   * patch that bound nothing fails startup loud (naming the patch id) instead
   * of silently shipping an inert transform — the filePath may be the wrong
   * launch form (src vs lib) or the function may have moved. Defaults to
   * false.
   */
  required?: boolean
  /**
   * Numeric ordering key; higher priorities run first, equal priorities
   * preserve stable registration order.
   */
  priority?: number
  /** Runtime behavior installed for this patch. */
  handler: StentHandler
}

/** Immutable diagnostic snapshot of one registered patch (no handler functions). */
export interface StentPatchInfo {
  /** Patch id. */
  id: PatchId
  /** Target descriptor. */
  target: StentTarget
  /** Behavior kind. */
  operation: StentOperation
  /** Registration priority (defaults to 0); higher runs first. */
  priority: number
  /** Whether this patch must bind a target during startup. */
  required?: boolean
  /** Whether the patch is currently installed. */
  enabled: boolean
  /**
   * Load-time bindings recorded for this patch, in recording order. Always
   * present on `list()` entries; registration inputs may omit it.
   */
  bindings?: readonly StentBinding[]
}
