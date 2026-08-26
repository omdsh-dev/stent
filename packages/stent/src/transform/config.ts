/**
 * Platform-neutral conversion from public Stent patch descriptors to the
 * Orchestrion instrumentation wire shape. Node and browser adapters consume
 * this module; it deliberately contains no loader or filesystem code.
 * @module @oh-my-dsh/stent/transform/config
 */

import type { InstrumentationConfig } from './orchestrion.ts'

export type { InstrumentationConfig } from './orchestrion.ts'
import { validatePatchId, validatePatchStatic } from '../runtime.ts'
import type { StentPatchStub } from '../types.ts'

/** Orchestrion config extended with Stent's bridge metadata. */
export type StentInstrumentationConfig = InstrumentationConfig & {
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

/** Build one Orchestrion instrumentation from a static Stent patch. */
export function patchInstrumentation(patch: StentPatchStub): StentInstrumentationConfig {
  validatePatchId(patch.id)
  validatePatchStatic(patch)
  const target = patch.target
  const rawQuery = target.astQuery
  if (typeof rawQuery === 'string' && rawQuery.trim().length === 0) {
    throw new Error('stent: patch target astQuery must not be blank')
  }
  const query = rawQuery ?? queryFromFunction(patch)
  const filePath = target.filePath
  if (filePath === undefined) {
    throw new Error('stent: patch target.filePaths must be expanded before instrumentation (use expandPatchStub)')
  }
  return {
    channelName: patch.id,
    module: {
      name: target.module,
      versionRange: target.versionRange,
      filePath,
    },
    astQuery: query,
    functionQuery:
      target.functionQuery && !target.astQuery
        ? { ...target.functionQuery, index: target.functionQuery.index ?? null }
        : { index: target.index ?? null },
    transform: 'stent',
    stentPatchId: patch.id,
    stentOperation: patch.operation,
    stentPriority: patch.priority ?? 0,
  }
}

/** Order instrumentations so higher priority handlers wrap first. */
export function orderInstrumentations(
  instrumentations: readonly StentInstrumentationConfig[],
): StentInstrumentationConfig[] {
  return [...instrumentations].sort((left, right) => left.stentPriority - right.stentPriority)
}

/** Derive the esquery selector for a name-based function query. */
function queryFromFunction(patch: StentPatchStub): string {
  const q = patch.target.functionQuery
  if (!q) throw new Error('stent: patch target must carry functionQuery or astQuery')
  const queries: string[] = []
  const method = 'methodName' in q ? q.methodName : 'privateMethodName' in q ? q.privateMethodName : undefined
  if (method) {
    const keyType = 'privateMethodName' in q ? 'PrivateIdentifier' : 'Identifier'
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
  if (queries.length === 0) throw new Error('stent: unsupported functionQuery shape')
  return queries.join(', ')
}

/** Expand filePaths targets into one instrumentation per package-relative file. */
export function expandPatchStub(patch: StentPatchStub): StentInstrumentationConfig[] {
  const { filePaths, ...target } = patch.target
  if (filePaths === undefined) return [patchInstrumentation(patch)]
  return filePaths.map(filePath =>
    patchInstrumentation({
      ...patch,
      target: { ...target, filePath },
    }),
  )
}
