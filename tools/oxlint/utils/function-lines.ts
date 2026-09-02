/**
 * Shared AST and source-line helpers for function-oriented Oxlint rules.
 *
 * @module stent/oxlint/utils/function-lines
 */

import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = RuleTester['run'] extends (
  ruleName: string,
  rule: infer InferredRule,
  tests: never,
) => void
  ? InferredRule
  : never
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type RuleContext = RuleFactory['create'] extends (
  context: infer InferredContext,
) => unknown
  ? InferredContext
  : never
type SourceCode = RuleContext['sourceCode']
type VisitorObject = ReturnType<RuleFactory['create']>

interface AstNode {
  readonly range: [number, number]
  readonly type?: string
  readonly parent?: unknown
  readonly id?: unknown
  readonly body?: unknown
  readonly init?: unknown
  readonly key?: unknown
  readonly value?: unknown
  readonly name?: string
}

interface LineCountOptions {
  readonly skipBlankLines: boolean
  readonly skipComments: boolean
}

/** A comment range clamped to the text of one node. */
interface CommentSpan {
  readonly from: number
  readonly to: number
}

const lineBreakPattern = /\r\n|\r|\n/u
const nonLineBreakPattern = /[^\n\r]/gu
const textStart = 0

/** Report whether an arbitrary value carries a source range. */
function isAstNode(value: unknown): value is AstNode {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return 'range' in value
}

/** Narrow an arbitrary AST property to a ranged node. */
function asNode(value: unknown): AstNode | undefined {
  if (!isAstNode(value)) {
    return undefined
  }
  return value
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

/** Return the name a declarator or method definition gives to a function. */
function parentBoundName(parent: AstNode, node: AstNode): string | undefined {
  if (parent.type === 'VariableDeclarator' && asNode(parent.init) === node) {
    return bindingName(parent.id)
  }
  if (parent.type === 'MethodDefinition' && asNode(parent.value) === node) {
    return propertyName(parent.key)
  }
  return undefined
}

/**
 * Return a readable name for a declaration, variable-bound function, or class
 * method.
 */
function functionName(node: AstNode): string | undefined {
  const id = asNode(node.id)
  if (typeof id?.name === 'string') {
    return id.name
  }

  const parent = asNode(node.parent)
  if (parent === undefined) {
    return undefined
  }
  return parentBoundName(parent, node)
}

/** Return the comment ranges that overlap a node, relative to its start. */
function commentSpans(node: AstNode, sourceCode: SourceCode): CommentSpan[] {
  const [start, end] = node.range
  const spans: CommentSpan[] = []
  for (const comment of sourceCode.getAllComments()) {
    const [commentStart, commentEnd] = comment.range
    const from = Math.max(commentStart, start) - start
    const to = Math.min(commentEnd, end) - start
    if (from < to) {
      spans.push({ from, to })
    }
  }
  return spans
}

/** Replace comment characters with spaces while preserving line breaks. */
function sourceWithoutComments(node: AstNode, sourceCode: SourceCode): string {
  const text = sourceCode.getText(node)
  let masked = ''
  let cursor = textStart
  for (const span of commentSpans(node, sourceCode)) {
    masked +=
      text.slice(cursor, span.from)
      + text.slice(span.from, span.to).replaceAll(nonLineBreakPattern, ' ')
    cursor = span.to
  }
  return masked + text.slice(cursor)
}

/** Return the node text, with comments blanked out when they are skipped. */
function codeText(
  node: AstNode,
  sourceCode: SourceCode,
  options: LineCountOptions,
): string {
  if (options.skipComments) {
    return sourceWithoutComments(node, sourceCode)
  }
  return sourceCode.getText(node)
}

/** Report whether one line contributes to the effective line count. */
function isCountedLine(
  sourceLine: string,
  codeLine: string,
  options: LineCountOptions,
): boolean {
  const blank = sourceLine.trim() === ''
  if (options.skipBlankLines && blank) {
    return false
  }
  if (options.skipComments && !blank && codeLine.trim() === '') {
    return false
  }
  return true
}

/** Count source lines with configurable blank-line and comment-line handling. */
function countLines(
  node: AstNode,
  sourceCode: SourceCode,
  options: LineCountOptions,
): number {
  const sourceLines = sourceCode.getText(node).split(lineBreakPattern)
  const codeLines = codeText(node, sourceCode, options).split(lineBreakPattern)
  const counted = sourceLines.filter((sourceLine, index) =>
    isCountedLine(sourceLine, codeLines[index] ?? '', options),
  )
  return counted.length
}

export { asNode, countLines, functionName, sourceWithoutComments }
export type {
  AstNode,
  LineCountOptions,
  Rule,
  RuleContext,
  SourceCode,
  VisitorObject,
}
