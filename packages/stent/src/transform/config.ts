/**
 * Platform-neutral conversion from public Stent patch descriptors to the
 * Orchestrion instrumentation wire shape. Node and browser adapters consume
 * this module; it deliberately contains no loader or filesystem code.
 *
 * @module @oh-my-dsh/stent/transform/config
 */

import type { InstrumentationConfig } from './orchestrion.ts'
import type {
  StentFunctionQuery,
  StentPatchStub,
  StentTarget,
} from './types.ts'
import { validatePatchId, validatePatchStatic } from './validation.ts'

/** Length of a blank (whitespace-only) query string. */
const BLANK_QUERY_LENGTH = 0
/** Default priority when a patch does not declare one. */
const DEFAULT_PRIORITY = 0
/** A selector list that contains no supported queries. */
const NO_QUERIES = 0

/**
 * Internal Orchestrion config enriched with Stent bridge metadata.
 *
 * The `stent*` fields are trusted inputs to the custom transform and are broad
 * strings because this type is also used after the loader wire boundary.
 */
type StentInstrumentationConfig = InstrumentationConfig & {
  /** Patch id stamped into every generated call. */
  stentPatchId: string
  /** Operation kind stamped into every generated call. */
  stentOperation: string
  /** Patch priority used for stable nesting order. */
  stentPriority: number
  /** Selects the Stent custom transform. */
  transform: 'stent'
  /** Raw esquery selector choosing the node(s) to instrument. */
  astQuery: string
}

/**
 * Normalize the function-query index to an explicit `null` (all matches).
 *
 * @param target - The patch target carrying the index fields.
 * @returns The function query with a normalized index; an AST-query target
 *   yields only the behavior index.
 */
function normalizedFunctionQuery(
  target: StentTarget,
): StentFunctionQuery | { index: number | null } {
  if (
    target.functionQuery !== undefined
    && target.functionQuery !== null
    && target.astQuery === undefined
  ) {
    const query = target.functionQuery
    return { ...query, index: query.index ?? null }
  }
  return { index: target.index ?? null }
}

/** Method name and key type of a name query, when it selects a method. */
function queryMethod(
  query: StentFunctionQuery,
): { method: string; keyType: 'PrivateIdentifier' | 'Identifier' } | undefined {
  if ('methodName' in query) {
    return { method: query.methodName, keyType: 'Identifier' }
  }
  if ('privateMethodName' in query) {
    return { method: query.privateMethodName, keyType: 'PrivateIdentifier' }
  }
  return undefined
}

/** Selectors matching a method by its name and key type. */
function methodSelectorQueries(
  method: string,
  keyType: 'PrivateIdentifier' | 'Identifier',
): string[] {
  return [
    `ClassBody > [key.name="${method}"][key.type=${keyType}] > [async]`,
    `Property[key.name="${method}"][key.type=${keyType}] > [async]`,
  ]
}

/** Selectors matching a named function declaration or variable. */
function functionNameQueries(name: string): string[] {
  return [
    `FunctionDeclaration[id.name="${name}"][async]`,
    `VariableDeclarator[id.name="${name}"] > FunctionExpression[async]`,
    `VariableDeclarator[id.name="${name}"] > ArrowFunctionExpression[async]`,
  ]
}

/** Selectors matching a named function expression or arrow variable. */
function expressionNameQueries(name: string): string[] {
  return [
    `FunctionExpression[id.name="${name}"][async]`,
    `ArrowFunctionExpression[id.name="${name}"][async]`,
    `VariableDeclarator[id.name="${name}"] > FunctionExpression[async]`,
    `VariableDeclarator[id.name="${name}"] > ArrowFunctionExpression[async]`,
  ]
}

/** Collect the esquery selectors of one name-based function query. */
function nameQueries(query: StentFunctionQuery): string[] {
  const queries: string[] = []
  const methodTarget = queryMethod(query)
  if (methodTarget !== undefined && methodTarget.method !== '') {
    queries.push(
      ...methodSelectorQueries(methodTarget.method, methodTarget.keyType),
    )
  }
  if ('functionName' in query) {
    queries.push(...functionNameQueries(query.functionName))
  }
  if ('expressionName' in query) {
    queries.push(...expressionNameQueries(query.expressionName))
  }
  return queries
}

/**
 * Derive the esquery selector for a supported name-based function query. Names
 * are interpolated as supplied; callers needing escaping or class/alias
 * narrowing should use an explicit `astQuery` instead.
 *
 * @param patch - Patch whose target carries the name query.
 * @returns Comma-separated selectors for method, function, or expression forms.
 * @throws If no supported name field is present.
 */
function queryFromFunction(patch: StentPatchStub): string {
  const query = patch.target.functionQuery
  if (typeof query !== 'object' || query === null) {
    throw new Error('stent: patch target must carry functionQuery or astQuery')
  }
  const queries = nameQueries(query)
  if (queries.length === NO_QUERIES) {
    throw new Error('stent: unsupported functionQuery shape')
  }
  return queries.join(', ')
}

/**
 * Build one Orchestrion instrumentation after the caller validates a static
 * patch.
 *
 * @param patch - Patch whose file selector has already been reduced to
 *   `filePath`. The raw-query branch emits only `{ index }`; the name-query
 *   branch copies the function query and normalizes its index to `null` when
 *   omitted.
 * @throws If the AST query is blank, no supported name query is present, or the
 *   file selector has not been expanded.
 */
function patchInstrumentation(
  patch: StentPatchStub,
): StentInstrumentationConfig {
  const { target } = patch
  const rawQuery = target.astQuery
  if (
    typeof rawQuery === 'string'
    && rawQuery.trim().length === BLANK_QUERY_LENGTH
  ) {
    throw new Error('stent: patch target astQuery must not be blank')
  }
  const { filePath } = target
  if (filePath === undefined) {
    throw new Error(
      'stent: patch target.filePaths must be expanded before instrumentation (use expandPatchStub)',
    )
  }
  const functionQuery = normalizedFunctionQuery(target)
  return {
    channelName: patch.id,
    module: {
      name: target.module,
      versionRange: target.versionRange,
      filePath,
    },
    astQuery: rawQuery ?? queryFromFunction(patch),
    functionQuery,
    transform: 'stent',
    stentPatchId: patch.id,
    stentOperation: patch.operation,
    stentPriority: patch.priority ?? DEFAULT_PRIORITY,
  }
}

/**
 * Order an instrumentation snapshot by priority.
 *
 * @param instrumentations - Configs to copy and sort.
 * @returns A new ascending-priority array; the input is not mutated.
 */
function orderInstrumentations(
  instrumentations: readonly StentInstrumentationConfig[],
): StentInstrumentationConfig[] {
  return [...instrumentations].toSorted(
    (left, right) => left.stentPriority - right.stentPriority,
  )
}

/**
 * Validate and expand one public patch stub into matcher configurations.
 *
 * @param patch - Static patch metadata without an executable handler.
 * @returns One config for `filePath`, or one config per `filePaths` entry. The
 *   public `required` flag is validated before expansion but is intentionally
 *   not emitted into this internal config.
 * @throws If static fields or file-path expansion fails, the AST query is
 *   blank, or no supported name query is available.
 */
function expandPatchStub(patch: StentPatchStub): StentInstrumentationConfig[] {
  validatePatchId(patch.id)
  validatePatchStatic(patch)
  const { filePaths, ...target } = patch.target
  if (filePaths === undefined) {
    return [patchInstrumentation(patch)]
  }
  return filePaths.map((filePath) =>
    patchInstrumentation({
      ...patch,
      target: { ...target, filePath },
    }),
  )
}

export { orderInstrumentations, expandPatchStub }
export type { StentInstrumentationConfig }
