/**
 * Stable global protocol names shared by the transform and runtime bridge.
 *
 * @module @oh-my-dsh/stent/transform/protocol
 */

/**
 * Name of the `globalThis` property under which the bridge installs `{ publish
 * }`. Generated code indexes `globalThis` with this stable key rather than
 * importing the runtime bridge into the transformed module.
 */
const GLOBAL_BRIDGE_KEY = '__stentBridge'

export { GLOBAL_BRIDGE_KEY }
