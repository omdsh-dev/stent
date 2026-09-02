/**
 * Runtime dispatch and registry support for the process-local Stent registry.
 *
 * This module keeps the bridge-call adapter, the patch-entry shape, and the
 * pure registry helpers (target identity and the runtime's stable string order)
 * separate from the registry lifecycle so the runtime facade stays below the
 * file-size limit.
 *
 * @module @oh-my-dsh/stent/runtime-dispatch
 */

import type { StentBridgeCall } from './bridge.ts'
import type {
  StentCall,
  StentHandler,
  StentInvoke,
  StentOperation,
  StentPatchChange,
  StentPatchInfo,
  StentTarget,
} from './types.ts'

/** The registry state dispatch needs: the operation and its bound handler. */
interface DispatchEntry {
  info: Pick<StentPatchInfo, 'operation'>
  handler: StentHandler | undefined
}

/**
 * Widened view of the handler union. Its members are distinguished only by
 * their arity, and every one of them takes the call record first, so a
 * rest-parameter view lets the operation select the calling convention at
 * runtime without narrowing the union.
 */
type HandlerView = (call: StentCall, ...rest: readonly StentInvoke[]) => unknown

/** One handler invocation: its calling convention and the values it runs on. */
interface HandlerRun {
  operation: StentOperation
  handler: HandlerView
  record: StentCall
  invoke: StentInvoke
}

/** Order of `left` before `right` in the runtime's stable lexical order. */
const ORDER_BEFORE = -1
/** Order of `left` after `right`. */
const ORDER_AFTER = 1
/** Order of two equal strings. */
const ORDER_EQUAL = 0
/**
 * Spelling of an absent target-key part. It matches what the previous
 * `JSON.stringify(null)`/`String(null)` formulation produced, so target keys
 * keep their shape.
 */
const ABSENT_KEY_PART = 'null'

/** The change record published after a patch registered or re-registered. */
function registerChange(
  info: StentPatchInfo,
  previous: StentPatchInfo | undefined,
): StentPatchChange {
  if (previous === undefined) {
    return { type: 'register', id: info.id, current: info }
  }
  return { type: 'register', id: info.id, current: info, previous }
}

/** Compare strings using the runtime's stable lexical order. */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return ORDER_BEFORE
  }
  if (left > right) {
    return ORDER_AFTER
  }
  return ORDER_EQUAL
}

/** Order patch infos by priority, then by id. */
function comparePatchOrder(
  left: StentPatchInfo,
  right: StentPatchInfo,
): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority
  }
  return compareStrings(left.id, right.id)
}

/** The selector part of a target key: its AST query or its function query. */
function selectorKey(target: StentTarget): string {
  if (target.astQuery !== undefined) {
    return target.astQuery
  }
  if (target.functionQuery === undefined) {
    return ABSENT_KEY_PART
  }
  return JSON.stringify(target.functionQuery)
}

/** The file part of a target key: `filePath`, the joined `filePaths`, or none. */
function filesKey(target: StentTarget): string {
  if (target.filePath !== undefined) {
    return String(target.filePath)
  }
  if (target.filePaths !== undefined) {
    return target.filePaths.join('|')
  }
  return ABSENT_KEY_PART
}

/** Stable identity of a patch target for conflict detection. */
function targetKey(target: StentTarget): string {
  return [
    target.module,
    target.versionRange,
    filesKey(target),
    selectorKey(target),
  ].join('|')
}

/**
 * Whether a value is a thenable result (including one from a synchronous
 * target).
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('then' in value)) {
    return false
  }
  return typeof value.then === 'function'
}

/**
 * Expose the settled result to an `after` handler and keep either its return
 * value or the result it mutated in place.
 */
function rewriteResult(run: HandlerRun, value: unknown): unknown {
  run.record.result = value
  const rewritten = run.handler(run.record)
  if (rewritten === undefined) {
    return run.record.result
  }
  return rewritten
}

/** Run an `after` handler once the traced body (or its promise) has settled. */
function runAfter(run: HandlerRun): unknown {
  const result = run.invoke()
  if (isThenable(result)) {
    /* Async target: rewrite after the promise settles. The caller already
       holds the original promise, so the rewritten promise is returned. */
    return result.then((value) => rewriteResult(run, value))
  }
  return rewriteResult(run, result)
}

/**
 * Run the enabled handler for one transformed call. `before` mutates arguments
 * then delegates; `after` delegates, exposes the settled result, and uses
 * either the handler return value or an in-place result mutation; `around` and
 * `replace` decide whether the original body runs and may supply their own
 * result.
 */
function dispatch(entry: DispatchEntry, call: StentBridgeCall): unknown {
  const { handler } = entry
  if (handler === undefined) {
    return call.traced()
  }
  const run: HandlerRun = {
    operation: entry.info.operation,
    handler,
    record: { arguments: call.arguments, self: call.self },
    invoke: call.traced.bind(call),
  }
  if (run.operation === 'before') {
    run.handler(run.record)
    return run.invoke()
  }
  if (run.operation === 'after') {
    return runAfter(run)
  }
  /* `around` and `replace` share the two-argument calling convention. */
  return run.handler(run.record, run.invoke)
}

export {
  comparePatchOrder,
  compareStrings,
  dispatch,
  registerChange,
  targetKey,
}
