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
import type { PatchId, StentOperation } from './types.ts'

/** Call record published by transformed code and consumed by the runtime. */
interface StentBridgeCall {
  /** The patch id this transformed call belongs to. */
  id: PatchId
  /** Operation kind the transform was generated for. */
  operation: StentOperation
  /**
   * Handler-visible arguments: a shallow slice for ordinary functions or a
   * synthetic parameter-pattern array for arrows.
   */
  arguments: unknown[]
  /** `this` receiver of the original call. */
  self: unknown
  /** The original function body, invoked with the current arguments. */
  traced: () => unknown
}

/** One bridge listener: dispatches a call and returns its result. */
type BridgeListener = (call: StentBridgeCall) => unknown

/** Owns bridge subscriptions and dispatches calls in registration order. */
class BridgeDispatcher {
  readonly #listeners = new Set<BridgeListener>()

  public subscribe(listener: BridgeListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  public publish(call: StentBridgeCall): unknown {
    const pending = this.#listeners.values()
    const first = pending.next()
    if (first.done === true) {
      return call.traced()
    }
    let result = first.value(call)
    for (const listener of pending) {
      result = listener(call)
    }
    return result
  }
}

const bridge = new BridgeDispatcher()

/** Subscribe to transformed calls. */
function subscribeBridge(listener: BridgeListener): () => void {
  const dispose = bridge.subscribe(listener)
  return (): void => {
    dispose()
  }
}

/** Publish one transformed call to the runtime. */
function publish(call: StentBridgeCall): unknown {
  const dispatcher = bridge
  const result = dispatcher.publish(call)
  return result
}

/**
 * Install the bridge handle into the current global object.
 *
 * @param globalObject - Target global object; defaults to `globalThis`.
 */
function installBridge(globalObject: object = globalThis): void {
  Object.assign(globalObject, {
    [GLOBAL_BRIDGE_KEY]: { publish },
  })
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
function isStentInstalled(globalObject: object = globalThis): boolean {
  if (!(GLOBAL_BRIDGE_KEY in globalObject)) {
    return false
  }
  return globalObject[GLOBAL_BRIDGE_KEY] !== undefined
}

export { installBridge, isStentInstalled, publish, subscribeBridge }
export { GLOBAL_BRIDGE_KEY } from './transform/protocol.ts'
export type { StentBridgeCall }
