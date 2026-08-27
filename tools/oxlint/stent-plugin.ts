/**
 * Project-local Oxlint rules.
 *
 * Oxlint loads this TypeScript plugin directly through the repository's
 * configuration; Node's built-in type stripping handles the runtime import.
 * @module stent/oxlint-plugin
 */

import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type RuleContext = Parameters<RuleFactory['create']>[0]
type VisitorObject = ReturnType<RuleFactory['create']>
type OxlintPlugin = {
  meta: {
    name: string
  }
  rules: Record<string, Rule>
}

type FunctionKind = 'declaration' | 'expression' | 'method' | 'arrow'
type MinimumLines = number | false

type AstNode = {
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

interface RuleOptions {
  minLines?: number
  minimums?: Partial<Record<FunctionKind, MinimumLines>>
  includeAnonymous?: boolean
  skipBlankLines?: boolean
  skipComments?: boolean
}

/** Narrow an arbitrary AST property to a ranged node. */
function asNode(value: unknown): AstNode | undefined {
  return typeof value === 'object' && value !== null && 'range' in value ? (value as AstNode) : undefined
}

/** Return a readable name for a declaration, variable-bound function, or class method. */
function functionName(node: AstNode): string | undefined {
  const id = asNode(node.id)
  if (typeof id?.name === 'string') return id.name

  const parent = asNode(node.parent)
  if (!parent) return undefined
  if (parent.type === 'VariableDeclarator' && asNode(parent.init) === node) return bindingName(parent.id)
  if (parent.type === 'MethodDefinition' && asNode(parent.value) === node) return propertyName(parent.key)
  return undefined
}

/** Classify a function so each syntax can have an independent threshold. */
function functionKind(node: AstNode): FunctionKind {
  if (node.type === 'FunctionDeclaration') return 'declaration'
  if (node.type === 'ArrowFunctionExpression') return 'arrow'
  const parent = asNode(node.parent)
  return parent?.type === 'MethodDefinition' && asNode(parent.value) === node ? 'method' : 'expression'
}

/** Resolve the configured threshold; `false` disables one function syntax. */
function minimumFor(kind: FunctionKind, options: RuleOptions): number | undefined {
  const configured = options.minimums?.[kind]
  if (configured === false) return undefined
  return configured ?? options.minLines ?? 5
}

/** Return the name bound by a simple variable declarator. */
function bindingName(pattern: unknown): string | undefined {
  const node = asNode(pattern)
  return node?.type === 'Identifier' ? node.name : undefined
}

/** Return a class method's identifier or literal property name. */
function propertyName(key: unknown): string | undefined {
  const node = asNode(key)
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) {
    return String(node.value)
  }
  return undefined
}

/** Replace comment characters with spaces while preserving line breaks. */
function sourceWithoutComments(node: AstNode, sourceCode: RuleContext['sourceCode']): string {
  const text = sourceCode.getText(node)
  const chars = text.split('')
  const start = node.range[0]
  const end = node.range[1]
  for (const comment of sourceCode.getAllComments()) {
    const commentStart = Math.max(comment.range[0], start) - start
    const commentEnd = Math.min(comment.range[1], end) - start
    if (commentStart >= commentEnd) continue
    for (let index = commentStart; index < commentEnd; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
    }
  }
  return chars.join('')
}

/** Count the function's effective source lines, excluding blank/comment-only lines when configured. */
function countLines(node: AstNode, sourceCode: RuleContext['sourceCode'], options: RuleOptions): number {
  const text = sourceCode.getText(node)
  const code = options.skipComments === true ? sourceWithoutComments(node, sourceCode) : text
  const sourceLines = text.split(/\r\n|\r|\n/)
  const codeLines = code.split(/\r\n|\r|\n/)
  let count = 0
  for (let index = 0; index < sourceLines.length; index++) {
    const sourceLine = sourceLines[index] ?? ''
    const codeLine = codeLines[index] ?? ''
    const blank = sourceLine.trim() === ''
    const commentOnly = !blank && codeLine.trim() === ''
    if (options.skipBlankLines === true && blank) continue
    if (options.skipComments === true && commentOnly) continue
    count++
  }
  return count
}

function isRuleOptions(value: unknown): value is RuleOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const minFunctionLines: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require functions to contain a minimum number of effective source lines',
    },
    schema: [
      {
        oneOf: [
          { type: 'integer', minimum: 1 },
          {
            type: 'object',
            properties: {
              minLines: { type: 'integer', minimum: 1 },
              minimums: {
                type: 'object',
                properties: {
                  declaration: {
                    oneOf: [
                      { type: 'integer', minimum: 1 },
                      { type: 'boolean', enum: [false] },
                    ],
                  },
                  expression: {
                    oneOf: [
                      { type: 'integer', minimum: 1 },
                      { type: 'boolean', enum: [false] },
                    ],
                  },
                  method: {
                    oneOf: [
                      { type: 'integer', minimum: 1 },
                      { type: 'boolean', enum: [false] },
                    ],
                  },
                  arrow: {
                    oneOf: [
                      { type: 'integer', minimum: 1 },
                      { type: 'boolean', enum: [false] },
                    ],
                  },
                },
                additionalProperties: false,
              },
              includeAnonymous: { type: 'boolean' },
              skipBlankLines: { type: 'boolean' },
              skipComments: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        ],
      },
    ],
    messages: {
      tooShort: '{{name}} has {{actual}} effective lines; minimum is {{min}}.',
    },
  },

  create(context: RuleContext): VisitorObject {
    const raw = context.options[0]
    const options = typeof raw === 'number' ? { minLines: raw } : isRuleOptions(raw) ? raw : {}
    const includeAnonymous = options.includeAnonymous ?? false
    const skipBlankLines = options.skipBlankLines ?? true
    const skipComments = options.skipComments ?? true

    function check(node: AstNode): void {
      const minLines = minimumFor(functionKind(node), options)
      if (minLines === undefined) return
      const name = functionName(node)
      if (name === undefined && !includeAnonymous) return
      const actual = countLines(node, context.sourceCode, { skipBlankLines, skipComments })
      if (actual < minLines) {
        context.report({
          node,
          messageId: 'tooShort',
          data: { name: name ?? '<anonymous>', actual, min: minLines },
        })
      }
    }

    return {
      FunctionDeclaration(node) {
        check(node)
      },
      FunctionExpression(node) {
        check(node)
      },
      ArrowFunctionExpression(node) {
        check(node)
      },
    }
  },
}

const plugin: OxlintPlugin = {
  meta: {
    name: 'stent',
  },
  rules: {
    'min-function-lines': minFunctionLines,
  },
}

export { minFunctionLines }
export default plugin
