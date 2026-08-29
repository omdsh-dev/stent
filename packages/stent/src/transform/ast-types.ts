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

/** One matched function with its parameter list. */
export interface MatchedFunction {
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

/** Allocator for names that are unique within one transformed program. */
export interface NameAllocator {
  unique(base: string): string
}
