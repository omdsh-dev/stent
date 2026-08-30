/**
 * Shared AST and source-line helpers for function-oriented Oxlint rules.
 *
 * @module stent/oxlint/utils/function-lines
 */

import type { RuleTester } from 'oxlint/plugins-dev'

type RuleFactory = Extract<
  Parameters<RuleTester['run']>[1],
  { create: (...args: never[]) => unknown }
>
export type RuleContext = Parameters<RuleFactory['create']>[0]
export type SourceCode = RuleContext['sourceCode']

export type AstNode = {
  range: [number, number]
  type?: string
  parent?: unknown
  id?: unknown
  body?: unknown
  init?: unknown
  key?: unknown
  value?: unknown
  name?: string
}

export interface LineCountOptions {
  skipBlankLines: boolean
  skipComments: boolean
}

/** Narrow an arbitrary AST property to a ranged node. */
export function asNode(value: unknown): AstNode | undefined {
  return typeof value === 'object' && value !== null && 'range' in value
    ? (value as AstNode)
    : undefined
}

/**
 * Return a readable name for a declaration, variable-bound function, or class
 * method.
 */
export function functionName(node: AstNode): string | undefined {
  const id = asNode(node.id)
  if (typeof id?.name === 'string') {
    return id.name
  }

  const parent = asNode(node.parent)
  if (!parent) {
    return undefined
  }
  if (parent.type === 'VariableDeclarator' && asNode(parent.init) === node) {
    return bindingName(parent.id)
  }
  if (parent.type === 'MethodDefinition' && asNode(parent.value) === node) {
    return propertyName(parent.key)
  }
  return undefined
}

/** Return the name bound by a simple variable declarator. */
function bindingName(pattern: unknown): string | undefined {
  const node = asNode(pattern)
  if (node?.type !== 'Identifier') {
    return undefined
  }
  return node.name
}

/** Return a class method's identifier or literal property name. */
function propertyName(key: unknown): string | undefined {
  const node = asNode(key)
  if (node?.type === 'Identifier') {
    return node.name
  }
  if (
    node?.type === 'Literal'
    && (typeof node.value === 'string' || typeof node.value === 'number')
  ) {
    return String(node.value)
  }
  return undefined
}

/** Replace comment characters with spaces while preserving line breaks. */
export function sourceWithoutComments(
  node: AstNode,
  sourceCode: SourceCode,
): string {
  const text = sourceCode.getText(node)
  const chars = text.split('')
  const start = node.range[0]
  const end = node.range[1]
  for (const comment of sourceCode.getAllComments()) {
    const commentStart = Math.max(comment.range[0], start) - start
    const commentEnd = Math.min(comment.range[1], end) - start
    if (commentStart >= commentEnd) {
      continue
    }
    for (let index = commentStart; index < commentEnd; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') {
        chars[index] = ' '
      }
    }
  }
  return chars.join('')
}

/** Count source lines with configurable blank-line and comment-line handling. */
export function countLines(
  node: AstNode,
  sourceCode: SourceCode,
  options: LineCountOptions,
): number {
  const text = sourceCode.getText(node)
  const code = options.skipComments
    ? sourceWithoutComments(node, sourceCode)
    : text
  const sourceLines = text.split(/\r\n|\r|\n/)
  const codeLines = code.split(/\r\n|\r|\n/)
  let count = 0
  for (let index = 0; index < sourceLines.length; index++) {
    const sourceLine = sourceLines[index] ?? ''
    const codeLine = codeLines[index] ?? ''
    const blank = sourceLine.trim() === ''
    const commentOnly = !blank && codeLine.trim() === ''
    if (options.skipBlankLines && blank) {
      continue
    }
    if (options.skipComments && commentOnly) {
      continue
    }
    count++
  }
  return count
}
