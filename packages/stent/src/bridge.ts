/**
 * The Stent runtime bridge — the single process-local entrypoint that
 * transformed target code calls. The bootstrap installs `publish` as a
 * `globalThis` handle; transformed code (ESM or CJS) emits
 * `globalThis[<key>].publish(call)` with no module import of its own.
 *
 * The bridge is deliberately tiny and Cordis-free: it carries no `Context`, no
 * registry state, and no knowledge of the target module. It is also
 * platform-free: dispatch runs through an in-memory listener set with no
 * `node:*` imports, so the same bridge serves the Node host and the browser
 * build (the runtime subscribes through {@link subscribeBridge}).
 *
 * @module @oh-my-dsh/stent/bridge
 */

import { GLOBAL_BRIDGE_KEY } from './transform/protocol.ts'
import type { StentOperation, PatchId } from './types.ts'

export { GLOBAL_BRIDGE_KEY }

/** Call record published by transformed code and consumed by the runtime. */
export interface StentBridgeCall {
  /** The patch id this transformed call belongs to. */
  id: PatchId
  /** Operation kind the transform was generated for. */
  operation: StentOperation
  /** Call arguments; `before` handlers mutate them in place. */
  arguments: unknown[]
  /** `this` receiver of the original call. */
  self: unknown
  /** The original function body, invoked with the current arguments. */
  traced: () => unknown
}

/** One bridge listener: dispatches a call and returns its result. */
export type BridgeListener = (call: StentBridgeCall) => unknown

/** Bridge listeners in registration order (the runtime registers exactly one). */
const listeners = new Set<BridgeListener>()

/**
 * Subscribe to transformed calls.
 *
 * @param listener - Dispatch function for every published call.
 * @returns A disposer removing the listener.
 */
export function subscribeBridge(listener: BridgeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Publish one transformed call to the runtime. Returns the value the caller
 * should return: the handler's result for `around`/`replace`, or the traced
 * body's result (rewritten by `after` handlers) for `before`/`after`.
 *
 * With multiple listeners (e.g. several `StentRuntime` instances in one
 * process), every listener sees the call in registration order — earlier
 * listeners' argument/result mutations are visible to later ones — and the last
 * listener's result is returned.
 *
 * @param call - The call record assembled by the transform.
 * @returns The value to return from the wrapped function.
 */
export function publish(call: StentBridgeCall): unknown {
  if (listeners.size === 0) {
    // No handler is registered for this patch (disabled, disposed, or the
    // patch was never enabled): delegate to the original body untouched.
    return call.traced()
  }
  let result: unknown
  for (const listener of listeners) {
    result = listener(call)
  }
  return result
}

/**
 * Install the bridge handle into the current global object.
 *
 * @param globalObject - Target global object; defaults to `globalThis`.
 */
export function installBridge(globalObject: object = globalThis): void {
  const bridge = { publish }
  const target = globalObject as Record<string, unknown>
  target[GLOBAL_BRIDGE_KEY] = bridge
}

/**
 * Whether the Stent bridge handle is installed in the current global object.
 *
 * The bridge is installed by `installStentHooks` (Node host) and by the browser
 * entry's `apply`, so its presence marks the transformation machinery as
 * active: on the Node host, load-time hooks accompany the bridge, and in the
 * browser, build-time transforms fall back to the original body until this
 * handle exists. A consumer that needs the bridge before registering a patch
 * (e.g. a patch-backed adapter) checks this instead of assuming `ctx.stent`
 * implies installation.
 *
 * @param globalObject - Target global object; defaults to `globalThis`.
 * @returns Whether the bridge handle is present.
 */
export function isStentInstalled(globalObject: object = globalThis): boolean {
  const target = globalObject as Record<string, unknown>
  const bridge = target[GLOBAL_BRIDGE_KEY]
  return bridge !== undefined
}
