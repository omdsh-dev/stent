/**
 * Compatibility entry for the async loader's instrumentation wire helpers.
 *
 * The JSON representation belongs to the transform layer; this Node path is
 * retained for existing subpath consumers.
 * @module @oh-my-dsh/stent/node/wire
 */

export { reviveInstrumentation, serializeInstrumentation } from '../transform/wire.ts'
export type { StentWireInstrumentation } from '../transform/wire.ts'
