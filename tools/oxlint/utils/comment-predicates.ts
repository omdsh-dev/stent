import type { AstNode } from './function-lines.ts'

const transparentExpressionTypes = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
])

const directivePatterns = [
  /^(?:eslint|oxlint)-/i,
  /^@ts-/i,
  /^(?:istanbul|c8)\b/i,
  /^jscpd(?::|-|\s|$)/i,
  /^[@#]?__PURE__\b/i,
  /^@?vite-ignore\b/i,
  /^webpack(?:ignore|chunkname)\b/i,
]

/** Return whether a node is a transparent export expression. */
function isTransparentExpression(node: AstNode): boolean {
  if (node.type === undefined) {
    return false
  }
  return transparentExpressionTypes.has(node.type)
}

/** Return whether a comment is a tool directive rather than documentation. */
function isDirective(comment: { value: string }): boolean {
  const lines = comment.value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/^\*+/, '').trim())
  for (const line of lines) {
    for (const pattern of directivePatterns) {
      if (pattern.test(line)) {
        return true
      }
    }
  }
  return false
}

export { isTransparentExpression, isDirective }
