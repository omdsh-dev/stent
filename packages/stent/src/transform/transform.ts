/**
 * Orchestrion custom transform for Stent. Instead of the built-in tracing
 * transform (which always runs the original body inside its traced closure,
 * making `around`/`replace` vetoes impossible), this transform rewrites the
 * matched function to call the Stent bridge directly.
 *
 * The function keeps its name, `.length`, and `this` binding. The original body
 * moves into a `traced` closure that replays it via `apply(this, args)` over
 * the reconstructed arguments array, and the body becomes a single conditional
 * return: `globalThis[<bridge key>]` present → publish the call, absent →
 * delegate to the traced body untouched. The bridge-absent fallback makes
 * transformed code safe before the bootstrap runs (and in browsers before the
 * bridge is installed), at the cost of the patch only taking effect for calls
 * that happen after the bridge exists.
 *
 * Matched nodes must be function declarations, function expressions, methods,
 * or arrow functions with a block (or, for arrows, expression) body. Arrows
 * have no own `arguments` binding, so the argument array is rebuilt from the
 * parameter patterns (identifiers, rest, defaults, and destructuring all work —
 * the patterns bind their names before the injected statements run) and `this`
 * stays lexical; a body referencing the enclosing `arguments` object is
 * preserved by capturing it first. Generator functions transform through
 * delegation (`yield*` over the traced generator), so iteration semantics
 * survive the no-handler and delegated paths.
 *
 * @module @oh-my-dsh/stent/transform/transform
 */

import type { BlockStatement, Node } from 'estree'

import { mapOuterArguments, namesOf } from './arguments.ts'
import type { MatchedFunction, NameAllocator } from './ast-types.ts'
import type { InstrumentationMatcher } from './orchestrion.ts'
import { isConstructorTarget, matchFunction } from './patterns.ts'
import {
  createArgumentsStatement,
  createCallStatement,
  createInjectedStatements,
  createOuterArgumentsCapture,
  createPublishStatement,
  createTracedStatement,
} from './statements.ts'

/** Identifier prefixes injected by this transform. */
const ARGS = 'stentArguments'
const TRACED = 'stentTraced'
const CALL = 'stentCall'
const OUTER_ARGUMENTS = 'stentOuterArguments'

/**
 * Register the Stent custom transform on an Orchestrion matcher. Both the Node
 * loader and the browser build register the same operator, which reads the
 * patch id and operation from the merged state.
 *
 * @param matcher - The Orchestrion matcher to extend.
 * @param onMatch - Optional callback invoked with the patch id for every node
 *   the transform actually rewrites; the Node loader counts these into its
 *   load-time binding records.
 */
export function registerStentTransform(
  matcher: InstrumentationMatcher,
  onMatch?: (patchId: string) => void,
): void {
  matcher.addTransform('stent', (state, node, parent, ancestry) => {
    const patchId = state.stentPatchId
    const operation = state.stentOperation
    if (typeof patchId !== 'string' || typeof operation !== 'string') {
      throw new Error(
        'stent: transform config must carry stentPatchId and stentOperation strings',
      )
    }
    if (transformMatchedFunction(patchId, operation, node, parent, ancestry)) {
      onMatch?.(patchId)
    }
  })
}

function transformMatchedFunction(
  patchId: string,
  operation: string,
  node: Node,
  parent: Node,
  ancestry: Node[],
): boolean {
  if (isConstructorTarget(node, parent)) {
    throw new Error(
      'stent: constructor targets are not supported (super() and new.target cannot survive '
        + 'the traced-closure replay); patch a method or factory instead',
    )
  }
  const matched = matchFunction(node)
  const program = ancestry[ancestry.length - 1]
  if (!matched || !program || program.type !== 'Program') {
    return false
  }
  const block = ensureBlockBody(matched)
  const names = namesOf(program)
  const outerArgsName = prepareOuterArguments(matched, block, names)
  const argsName = names.unique(ARGS)
  const tracedName = names.unique(TRACED)
  const callName = names.unique(CALL)
  const capture = createOuterArgumentsCapture(outerArgsName)
  const args = createArgumentsStatement(matched, argsName)
  const traced = createTracedStatement(
    matched,
    block.body,
    argsName,
    tracedName,
  )
  const call = createCallStatement(
    patchId,
    operation,
    argsName,
    tracedName,
    callName,
  )
  const publish = createPublishStatement(matched, names, callName, tracedName)
  block.body = createInjectedStatements(capture, args, traced, call, publish)
  return true
}

function ensureBlockBody(matched: MatchedFunction): BlockStatement {
  if (matched.body.type !== 'BlockStatement') {
    const synthesized: BlockStatement = {
      type: 'BlockStatement',
      body: [{ type: 'ReturnStatement', argument: matched.body }],
    }
    matched.node.body = synthesized
    matched.body = synthesized
  }
  return matched.body
}

function prepareOuterArguments(
  matched: MatchedFunction,
  block: BlockStatement,
  names: NameAllocator,
): string | undefined {
  if (!matched.arrow || !mapOuterArguments(block, undefined)) {
    return undefined
  }
  const name = names.unique(OUTER_ARGUMENTS)
  mapOuterArguments(block, name)
  return name
}
