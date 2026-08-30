/**
 * Enforce a maximum aggregate cyclomatic complexity for one source file.
 *
 * The score starts at one for the file, adds one for every function, and adds
 * one for each conditional, loop, logical expression, catch clause, default
 * assignment, optional chain, logical assignment, or non-default switch case.
 * This uses the same decision set as Oxlint's `eslint/complexity` rule; nested
 * functions are included once instead of being counted through parents.
 *
 * @module stent/oxlint/rules/file-complexity
 */

import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type VisitorObject = ReturnType<RuleFactory['create']>
type RuleContext = Parameters<RuleFactory['create']>[0]
type VisitorKeys = Readonly<Record<string, readonly string[]>>

const functionTypes = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
])

const decisionTypes = new Set([
  'CatchClause',
  'ConditionalExpression',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'IfStatement',
  'LogicalExpression',
  'WhileStatement',
])

const logicalAssignmentOperators = new Set(['&&=', '||=', '??='])
const optionalChainTypes = new Set(['CallExpression', 'MemberExpression'])

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object') {
    return false
  }
  return value !== null
}

function nodeType(node: Record<string, unknown>): string | undefined {
  const type = node.type
  if (typeof type !== 'string') {
    return undefined
  }
  return type
}

function isDecisionNode(node: Record<string, unknown>, type: string): boolean {
  if (type === 'SwitchCase') {
    return node.test !== null
  }
  if (type === 'AssignmentPattern') {
    return true
  }
  if (type === 'AssignmentExpression') {
    if (typeof node.operator !== 'string') {
      return false
    }
    return logicalAssignmentOperators.has(node.operator)
  }
  if (decisionTypes.has(type)) {
    return true
  }
  return optionalChainTypes.has(type) && node.optional === true
}

function nodeComplexity(node: Record<string, unknown>): number {
  const type = nodeType(node)
  if (type === undefined) {
    return 0
  }
  let score = 0
  if (functionTypes.has(type)) {
    score++
  }
  if (isDecisionNode(node, type)) {
    score++
  }
  return score
}

function countArrayComplexity(
  values: unknown[],
  seen: WeakSet<object>,
  visitorKeys: VisitorKeys,
): number {
  let score = 0
  for (const value of values) {
    score += countComplexity(value, seen, visitorKeys)
  }
  return score
}

function countObjectComplexity(
  node: Record<string, unknown>,
  seen: WeakSet<object>,
  visitorKeys: VisitorKeys,
): number {
  const type = nodeType(node)
  if (type === undefined) {
    return 0
  }
  let score = nodeComplexity(node)
  const keys = visitorKeys[type] ?? []
  for (const key of keys) {
    score += countComplexity(node[key], seen, visitorKeys)
  }
  return score
}

function countComplexity(
  value: unknown,
  seen: WeakSet<object>,
  visitorKeys: VisitorKeys,
): number {
  if (Array.isArray(value)) {
    return countArrayComplexity(value, seen, visitorKeys)
  }
  if (!isObject(value) || seen.has(value)) {
    return 0
  }
  seen.add(value)
  return countObjectComplexity(value, seen, visitorKeys)
}

function calculateFileComplexity(
  value: unknown,
  visitorKeys: VisitorKeys,
): number {
  const seen = new WeakSet()
  const complexity = countComplexity(value, seen, visitorKeys)
  return 1 + complexity
}

function configuredMaximum(options: readonly unknown[]): number {
  const option = options[0]
  if (typeof option === 'number') {
    return option
  }
  if (
    typeof option === 'object'
    && option !== null
    && !Array.isArray(option)
    && typeof (option as { max?: unknown }).max === 'number'
  ) {
    return (option as { max: number }).max
  }
  return 100
}

const fileComplexity: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce a maximum aggregate complexity per file',
    },
    schema: [
      {
        oneOf: [
          { type: 'integer', minimum: 0 },
          {
            type: 'object',
            properties: {
              max: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
        ],
      },
    ],
    messages: {
      tooComplex: 'File has {{actual}} complexity; maximum is {{max}}.',
    },
  },

  create(context: RuleContext): VisitorObject {
    const max = configuredMaximum(context.options)
    return {
      Program(node) {
        const actual = calculateFileComplexity(
          node,
          context.sourceCode.visitorKeys,
        )
        if (actual > max) {
          context.report({
            node,
            messageId: 'tooComplex',
            data: { actual, max },
          })
        }
      },
    }
  },
}

export { fileComplexity }
