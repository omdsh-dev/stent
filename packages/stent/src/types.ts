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
interface StentCall {
  /**
   * Arguments exposed to handlers. Ordinary functions receive a shallow copy of
   * the arguments object (its values keep their identity); arrows receive a
   * synthetic array rebuilt from bound parameter patterns, so destructured
   * values are represented by partial copies rather than the caller object.
   */
  arguments: unknown[]
  /** `this` receiver of the original call. */
  self: unknown
  /** Optional package version metadata; current transform path leaves it unset. */
  moduleVersion?: string
  /** Successful traced result exposed to `after` (settled for thenable calls). */
  result?: unknown
}

/**
 * Call the original traced body with the (possibly mutated) call arguments. The
 * returned value follows the traced body; async functions normally return a
 * thenable, but a synchronous target may also return one explicitly.
 */
type StentInvoke = () => unknown

/**
 * `before` handler: observes and rewrites the call arguments. The original body
 * runs with the mutated arguments; the return value is ignored.
 *
 * @param call - The call record whose `arguments` array the handler may mutate.
 */
type StentBeforeHandler = (call: StentCall) => void

/**
 * `after` handler: observes the successful result; a thenable result is settled
 * before the handler runs. It may return any replacement value, so it need not
 * return a Promise for an async target, or mutate `call.result` and return
 * `undefined` to keep the original value.
 *
 * @param call - The call record whose `result` holds the original outcome.
 */
type StentAfterHandler = (call: StentCall) => unknown

/**
 * `around` handler: decides whether the original body runs and may replace its
 * result. Call `invoke()` to run the original body with the mutated arguments;
 * skip it to veto the original body and supply a result directly.
 *
 * @param call - The call record for this invocation.
 * @param invoke - Runs the original body with the current call arguments.
 */
type StentAroundHandler = (call: StentCall, invoke: StentInvoke) => unknown

/**
 * `replace` handler: owns the call. `invoke()` still runs the original body
 * with the mutated arguments when the handler chooses to delegate.
 *
 * @param call - The call record for this invocation.
 * @param invoke - Runs the original body with the current call arguments.
 */
type StentReplaceHandler = (call: StentCall, invoke: StentInvoke) => unknown

/** Dispatcher accepted for every operation kind. */
type StentHandler =
  | StentBeforeHandler
  | StentAfterHandler
  | StentAroundHandler
  | StentReplaceHandler

/**
 * One registered Stent patch. The handler is trusted code bound at registration
 * time; executable handlers are never deserialized from configuration.
 */
interface StentPatch {
  /**
   * Id within one Stent runtime. Each registration installs a fiber effect;
   * same-owner re-registration updates metadata and transfers fiber ownership,
   * so the stale disposer becomes a no-op. A different owner's claim fails.
   */
  id: PatchId
  /** The module, file, and function this patch transforms. */
  target: StentTarget
  /** Behavior kind of this patch. */
  operation: StentOperation
  /**
   * Load-time contract for the Node bootstrap: when true, it must observe at
   * least one transformed file for this patch after the application boots. A
   * required patch that bound nothing fails startup loud (naming the patch id)
   * instead of silently shipping an inert transform; browser transforms carry
   * this flag but do not enforce it. The filePath may be the wrong launch form
   * (src vs lib) or the function may have moved. Defaults to false.
   */
  required?: boolean
  /**
   * Numeric ordering key; higher priorities become outer layers. Entry order
   * for equal priorities is chosen by the adapter: static browser snapshots
   * preserve input order, while dynamic Node snapshots sort patch ids. Defaults
   * to 0.
   */
  priority?: number
  /** Runtime behavior installed for this patch. */
  handler: StentHandler
}

/** Immutable diagnostic snapshot of one registered patch (no handler functions). */
interface StentPatchInfo {
  /** Patch id. */
  id: PatchId
  /** Target descriptor. */
  target: StentTarget
  /** Behavior kind. */
  operation: StentOperation
  /** Registration priority (defaults to 0); higher priorities are outer layers. */
  priority: number
  /** Whether this Node bootstrap patch must bind a target during startup. */
  required?: boolean
  /** Whether the patch is currently installed. */
  enabled: boolean
  /**
   * Load-time bindings recorded for this patch, in recording order. Always
   * present on `list()` entries; registration inputs may omit it.
   */
  bindings?: readonly StentBinding[]
}

export type {
  StentCall,
  StentInvoke,
  StentBeforeHandler,
  StentAfterHandler,
  StentAroundHandler,
  StentReplaceHandler,
  StentHandler,
  StentPatch,
  StentPatchInfo,
}
