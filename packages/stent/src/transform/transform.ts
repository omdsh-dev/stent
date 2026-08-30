/**
 * Orchestrion custom transform for Stent. Instead of the built-in tracing
 * transform (which always runs the original body inside its traced closure,
 * making `around`/`replace` vetoes impossible), this transform rewrites the
 * matched function to call the Stent bridge directly.
 *
 * The outer node keeps its name and parameter list (and therefore its declared
 * `.length`). For ordinary functions, replay forwards the call receiver through
 * `apply(this, args)`; the original body moves into a traced closure. Ordinary
 * functions use a conditional publish/fallback return, while generators use a
 * result block and `yield*` delegation so iterator semantics remain intact.
 *
 * Arrows rebuild arguments from bound parameter patterns and preserve a lexical
 * receiver; a body reference to an enclosing `arguments` object is captured
 * heuristically. Constructor targets are rejected. Replay does not currently
 * preserve `new.target` or `super`, and moving a strict-CJS directive into the
 * traced closure can change receiver semantics; ordinary parameters or local
 * declarations that shadow `arguments`, and non-strict
 * `arguments.callee`/`caller` introspection, are not preserved. Broad raw
 * selectors must also exclude the injected replay closure to avoid recursive
 * matches during upstream AST traversal.
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
 * @returns Nothing; the matcher is mutated in place with the `stent` operator.
 * @throws During a later source transformation, if the merged config lacks the
 *   required Stent metadata or the matcher selects a constructor target.
 */
function registerStentTransform(
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

/** Rewrite one matcher hit and report its patch binding. */
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

/** Wrap an expression-bodied arrow in a return-bearing block. */
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

/** Capture and rewrite enclosing `arguments` references for an arrow. */
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

export { registerStentTransform }
