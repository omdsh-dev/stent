/**
 * Public Stent function-selection types.
 *
 * These are Stent-owned contracts. The transform implementation converts them
 * to the internal Orchestrion query shape; consumers do not need to depend on
 * Orchestrion's package or its declarations.
 * @module @oh-my-dsh/stent/transform/types
 */

/** Function execution mode understood by a Stent function target. */
export type StentFunctionKind = 'Sync' | 'Async' | 'Callback' | 'Auto'

/**
 * Select a function, method, class, private method, or named expression.
 * `index` is null/omitted to transform every match; a number selects one.
 */
export type StentFunctionQuery =
  | {
      className: string
      methodName: string
      kind: StentFunctionKind
      index?: number | null
      isExportAlias?: boolean
    }
  | {
      className: string
      privateMethodName: string
      kind: StentFunctionKind
      index?: number | null
    }
  | {
      className: string
      index?: number | null
      isExportAlias?: boolean
    }
  | {
      methodName: string
      kind: StentFunctionKind
      index?: number | null
    }
  | {
      functionName: string
      kind: StentFunctionKind
      index?: number | null
      isExportAlias?: boolean
    }
  | {
      expressionName: string
      kind: StentFunctionKind
      index?: number | null
      isExportAlias?: boolean
    }
