/**
 * Runtime dispatch state shared by the process-local Stent registry.
 *
 * This module keeps the bridge-call adapter and patch-entry shape separate from
 * the registry lifecycle so the runtime facade stays below the file-size
 * limit.
 *
 * @module @oh-my-dsh/stent/runtime-dispatch
 */

import type { StentBridgeCall } from './bridge.ts'
import type { StentCall, StentHandler, StentPatchInfo } from './types.ts'

interface DispatchEntry {
  info: Pick<StentPatchInfo, 'operation'>
  handler: StentHandler | undefined
}

/** Whether a value is a thenable (the async-target result shape). */
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
 * Run the enabled handler for one transformed call. `before` mutates arguments
 * then delegates; `after` delegates then mutates the result; `around` and
 * `replace` decide whether the original body runs and may supply their own
 * result.
 */
export function dispatch(entry: DispatchEntry, call: StentBridgeCall): unknown {
  const handler = entry.handler
  if (!handler) {
    return call.traced()
  }
  // The handler union's members are distinguished only by their arity; the
  // operation switch selects the calling convention at runtime.
  const observe = handler as (call: StentCall) => unknown

  const record: StentCall = {
    arguments: call.arguments,
    self: call.self,
  }
  const invoke = call.traced.bind(call)

  switch (entry.info.operation) {
    case 'before': {
      observe(record)
      return invoke()
    }
    case 'after': {
      const result = invoke()
      if (isThenable(result)) {
        // Async target: rewrite after the promise settles. The caller already
        // holds the original promise, so the rewritten promise is returned.
        return result.then((value) => {
          record.result = value
          const rewritten = observe(record)
          return rewritten === undefined ? record.result : rewritten
        })
      }
      record.result = result
      const rewritten = observe(record)
      return rewritten === undefined ? record.result : rewritten
    }
    case 'around':
    case 'replace': {
      // `around` and `replace` share the two-argument calling convention.
      return handler(record, invoke)
    }
  }
}
