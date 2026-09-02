/**
 * Shared local types for the Stent AST transform helpers.
 *
 * @module @oh-my-dsh/stent/transform/ast-types
 */

import type {
  ArrowFunctionExpression,
  BlockStatement,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Pattern,
} from 'estree'

/** Normalized function selected by a matcher query. */
interface MatchedFunction {
  /** The function-like node (MethodDefinition/Property unwrapped). */
  node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression
  /** Whether the node is an arrow function (lexical `this`/`arguments`). */
  arrow: boolean
  /** The function body (block, or an expression for expression-bodied arrows). */
  body: BlockStatement | Expression
  /** The parameter list. */
  params: Pattern[]
  /** Whether the node is an async function (its body may await). */
  async: boolean
  /** Whether the node is a generator function (its body may yield). */
  generator: boolean
}

/**
 * Allocate identifiers that do not collide with the transformed program.
 *
 * @param base - Preferred identifier prefix.
 * @returns `base` when free, otherwise a unique `base_N` name; each result is
 *   reserved for later allocations in the same program.
 */
interface NameAllocator {
  unique: (base: string) => string
}

export type { MatchedFunction, NameAllocator }
