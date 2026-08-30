/**
 * Platform-neutral conversion from public Stent patch descriptors to the
 * Orchestrion instrumentation wire shape. Node and browser adapters consume
 * this module; it deliberately contains no loader or filesystem code.
 *
 * @module @oh-my-dsh/stent/transform/config
 */

import type { InstrumentationConfig } from './orchestrion.ts'
import type { StentPatchStub } from './types.ts'
import { validatePatchId, validatePatchStatic } from './validation.ts'

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
  const target = patch.target
  const rawQuery = target.astQuery
  if (typeof rawQuery === 'string' && rawQuery.trim().length === 0) {
    throw new Error('stent: patch target astQuery must not be blank')
  }
  const filePath = target.filePath
  if (filePath === undefined) {
    throw new Error(
      'stent: patch target.filePaths must be expanded before instrumentation (use expandPatchStub)',
    )
  }
  let functionQuery = { index: target.index ?? null }
  if (target.functionQuery && !target.astQuery) {
    functionQuery = {
      ...target.functionQuery,
      index: target.functionQuery.index ?? null,
    }
  }
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
    stentPriority: patch.priority ?? 0,
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
  return [...instrumentations].sort(
    (left, right) => left.stentPriority - right.stentPriority,
  )
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
  const q = patch.target.functionQuery
  if (!q) {
    throw new Error('stent: patch target must carry functionQuery or astQuery')
  }
  const queries: string[] = []
  let method: string | undefined
  if ('methodName' in q) {
    method = q.methodName
  } else if ('privateMethodName' in q) {
    method = q.privateMethodName
  }
  if (method) {
    let keyType: 'PrivateIdentifier' | 'Identifier' = 'Identifier'
    if ('privateMethodName' in q) {
      keyType = 'PrivateIdentifier'
    }
    queries.push(
      `ClassBody > [key.name="${method}"][key.type=${keyType}] > [async]`,
      `Property[key.name="${method}"][key.type=${keyType}] > [async]`,
    )
  }
  if ('functionName' in q) {
    queries.push(
      `FunctionDeclaration[id.name="${q.functionName}"][async]`,
      `VariableDeclarator[id.name="${q.functionName}"] > FunctionExpression[async]`,
      `VariableDeclarator[id.name="${q.functionName}"] > ArrowFunctionExpression[async]`,
    )
  }
  if ('expressionName' in q) {
    queries.push(
      `FunctionExpression[id.name="${q.expressionName}"][async]`,
      `ArrowFunctionExpression[id.name="${q.expressionName}"][async]`,
      `VariableDeclarator[id.name="${q.expressionName}"] > FunctionExpression[async]`,
      `VariableDeclarator[id.name="${q.expressionName}"] > ArrowFunctionExpression[async]`,
    )
  }
  if (queries.length === 0) {
    throw new Error('stent: unsupported functionQuery shape')
  }
  return queries.join(', ')
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
