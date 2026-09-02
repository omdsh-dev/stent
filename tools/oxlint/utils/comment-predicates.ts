const transparentExpressionTypes = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
])

const directivePatterns = [
  /^(?:eslint|oxlint)-/iu,
  /^@ts-/iu,
  /^(?:istanbul|c8)\b/iu,
  /^jscpd(?::|-|\s|$)/iu,
  /^[@#]?__PURE__\b/iu,
  /^@?vite-ignore\b/iu,
  /^webpack(?:ignore|chunkname)\b/iu,
]

interface ReadableNode {
  readonly type?: string
}

/** Return whether a node is a transparent export expression. */
function isTransparentExpression(node: ReadableNode): boolean {
  if (node.type === undefined) {
    return false
  }
  return transparentExpressionTypes.has(node.type)
}

/** Return whether a comment is a tool directive rather than documentation. */
function isDirective(comment: Readonly<{ value: string }>): boolean {
  const lines = comment.value
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim().replace(/^\*+/u, '').trim())
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
