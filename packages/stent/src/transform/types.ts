/**
 * Self-contained contracts for the Stent transformation layer.
 *
 * The transform layer owns the static patch shape it consumes and the binding
 * reports it produces. Platform and runtime modules may import these contracts,
 * but this directory does not depend on them.
 *
 * @module @oh-my-dsh/stent/transform/types
 */

/**
 * Function kind accepted by name-query metadata. Name-query expansion preserves
 * the four upstream modes for compatibility, but raw-`astQuery` expansion
 * carries only index behavior and the Stent custom transform selects from AST
 * flags and operation.
 */
type StentFunctionKind = 'Sync' | 'Async' | 'Callback' | 'Auto'

/**
 * Select a function, method, class, private method, or named expression.
 * `index` is null (or omitted on a public stub, which expansion normalizes to
 * null) to transform every match; a number selects one zero-based match.
 * Low-level configs should set null explicitly because the upstream default is
 * the first match.
 *
 * This union mirrors the upstream query shape. The current Stent selector
 * builder implements `methodName`, `privateMethodName`, `functionName`, and
 * `expressionName`; `className` is not used to narrow those selectors and a
 * class-only query is unsupported. Because Stent supplies an explicit
 * `astQuery`, `isExportAlias` is not resolved by this adapter; use a precise
 * AST selector for class-specific or aliased targets.
 */
type StentFunctionQuery =
  | {
      readonly className: string
      readonly methodName: string
      readonly kind: StentFunctionKind
      readonly index?: number | null
      readonly isExportAlias?: boolean
    }
  | {
      readonly className: string
      readonly privateMethodName: string
      readonly kind: StentFunctionKind
      readonly index?: number | null
    }
  | {
      readonly className: string
      readonly index?: number | null
      readonly isExportAlias?: boolean
    }
  | {
      readonly methodName: string
      readonly kind: StentFunctionKind
      readonly index?: number | null
    }
  | {
      readonly functionName: string
      readonly kind: StentFunctionKind
      readonly index?: number | null
      readonly isExportAlias?: boolean
    }
  | {
      readonly expressionName: string
      readonly kind: StentFunctionKind
      readonly index?: number | null
      readonly isExportAlias?: boolean
    }

/** Stable identity of one Stent patch. */
type PatchId = string

/**
 * Operation applied by a transformed function call: `before` mutates arguments
 * then delegates, `after` observes the successful result, and
 * `around`/`replace` may delegate or veto the original body.
 */
type StentOperation = 'before' | 'after' | 'around' | 'replace'

/**
 * Static module and function selector consumed by the instrumentation builder.
 * Expansion requires one file selector and either a name query or an AST
 * query.
 */
interface StentTarget {
  /** Npm package name matched against the resolved module's owner. */
  readonly module: string
  /** Semver range the owning package version must satisfy. */
  readonly versionRange: string
  /**
   * Literal matcher path or regular expression; callers conventionally provide
   * a package-relative path, but validation performs no path normalization or
   * traversal check. Cannot be combined with `filePaths`; an empty string
   * currently passes static validation.
   */
  readonly filePath?: string | RegExp
  /**
   * Literal matcher paths; callers conventionally provide package-relative
   * paths, but validation does no normalization or traversal check. Expansion
   * creates one instrumentation per path and this field cannot be combined with
   * `filePath`.
   */
  readonly filePaths?: readonly string[]
  /**
   * Name-based function query. The current builder supports only the four name
   * fields described by {@link StentFunctionQuery}.
   */
  readonly functionQuery?: StentFunctionQuery
  /**
   * Raw esquery selector. It chooses the matched node and takes precedence over
   * the name-matching fields of `functionQuery`.
   */
  readonly astQuery?: string
  /**
   * Zero-based match index for raw AST queries; public expansion normalizes
   * omission to null (all matches).
   */
  readonly index?: number | null
}

/**
 * Public patch metadata converted into one or more instrumentation configs.
 * Handlers are intentionally absent: runtime code binds them after a target is
 * transformed and uses the `id` to associate binding reports with the patch.
 */
interface StentPatchStub {
  /** Id stamped into transformed calls and binding reports. */
  readonly id: PatchId
  /** Module, file, and function selector to expand and match. */
  readonly target: StentTarget
  /** Operation encoded into the bridge call and used by runtime dispatch. */
  readonly operation: StentOperation
  /**
   * Whether Node startup requires a binding for this patch. It is validated on
   * the public stub, then omitted from internal instrumentation; browser
   * transforms ignore it.
   */
  readonly required?: boolean
  /**
   * Ordering key, defaulting to `0`. Configs sort ascending so higher
   * priorities are nested outermost; entry order for equal priorities belongs
   * to the adapter.
   */
  readonly priority?: number
}

/** One transformed file binding. */
interface StentBinding {
  /** Package name of the bound module. */
  readonly module: string
  /** Package-relative file path that was transformed. */
  readonly file: string
  /** Number of AST function nodes successfully rewritten. */
  readonly nodes: number
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
