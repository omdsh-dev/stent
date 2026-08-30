/**
 * Self-contained contracts for the Stent transformation layer.
 *
 * The transform layer owns the static patch shape it consumes and the binding
 * reports it produces. Platform and runtime modules may import these contracts,
 * but this directory does not depend on them.
 *
 * @module @oh-my-dsh/stent/transform/types
 */

/** Function execution mode understood by a Stent function target. */
type StentFunctionKind = 'Sync' | 'Async' | 'Callback' | 'Auto'

/**
 * Select a function, method, class, private method, or named expression.
 * `index` is null/omitted to transform every match; a number selects one.
 */
type StentFunctionQuery =
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

/** Stable identity of one Stent patch. */
type PatchId = string

/** Operation applied by a transformed function call. */
type StentOperation = 'before' | 'after' | 'around' | 'replace'

/** Static target descriptor consumed by the instrumentation builder. */
interface StentTarget {
  /** Npm package name matched against the resolved module's owner. */
  module: string
  /** Semver range the owning package version must satisfy. */
  versionRange: string
  /** File path or pattern relative to the package root. */
  filePath?: string | RegExp
  /** Package-relative paths expanded into separate instrumentations. */
  filePaths?: string[]
  /** Name-based function query. */
  functionQuery?: StentFunctionQuery
  /** Raw esquery selector, taking precedence over functionQuery. */
  astQuery?: string
  /** Match index; null/omitted transforms every match. */
  index?: number | null
}

/** Static patch descriptor used by Node and browser transform entry points. */
interface StentPatchStub {
  /** Id stamped into transformed calls and binding reports. */
  id: PatchId
  /** Module and function selection metadata. */
  target: StentTarget
  /** Runtime operation stamped into the transformed call. */
  operation: StentOperation
  /** Whether startup must observe a binding for this patch. */
  required?: boolean
  /** Numeric ordering key for stacked instrumentations. */
  priority?: number
}

/** One transformed file binding. */
interface StentBinding {
  /** Package name of the bound module. */
  module: string
  /** Package-relative file path that was transformed. */
  file: string
  /** Function nodes rewritten in that file. */
  nodes: number
}

/** One transformed file binding carrying its patch id. */
interface StentBindingReport extends StentBinding {
  /** The patch id the node count belongs to. */
  patchId: PatchId
}

export type {
  StentFunctionKind,
  StentFunctionQuery,
  PatchId,
  StentOperation,
  StentTarget,
  StentPatchStub,
  StentBinding,
  StentBindingReport,
}
