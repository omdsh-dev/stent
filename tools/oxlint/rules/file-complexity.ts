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

type Rule = RuleTester['run'] extends (
  ruleName: string,
  rule: infer InferredRule,
  tests: never,
) => void
  ? InferredRule
  : never
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type VisitorObject = ReturnType<RuleFactory['create']>
type RuleContext = RuleFactory['create'] extends (
  context: infer InferredContext,
) => unknown
  ? InferredContext
  : never
type VisitorKeys = Readonly<Record<string, readonly string[]>>

/** Traversal state shared by one file-complexity walk. */
interface ComplexityScan {
  readonly seen: WeakSet<object>
  readonly visitorKeys: VisitorKeys
}

/** The score of one value plus the children still to visit. */
interface ComplexityStep {
  readonly score: number
  readonly children: readonly unknown[]
}

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

const defaultMaximum = 100
const baseComplexity = 1
const decisionPoint = 1
const noComplexity = 0
const emptyStep: ComplexityStep = { score: noComplexity, children: [] }

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object') {
    return false
  }
  return value !== null
}

function nodeType(node: Record<string, unknown>): string | undefined {
  const { type } = node
  if (typeof type !== 'string') {
    return undefined
  }
  return type
}

/** Report whether an assignment uses one of the logical operators. */
function isLogicalAssignment(node: Record<string, unknown>): boolean {
  const { operator } = node
  if (typeof operator !== 'string') {
    return false
  }
  return logicalAssignmentOperators.has(operator)
}

function isDecisionNode(node: Record<string, unknown>, type: string): boolean {
  if (type === 'SwitchCase') {
    return node.test !== null
  }
  if (type === 'AssignmentPattern') {
    return true
  }
  if (type === 'AssignmentExpression') {
    return isLogicalAssignment(node)
  }
  if (decisionTypes.has(type)) {
    return true
  }
  return optionalChainTypes.has(type) && node.optional === true
}

function nodeComplexity(node: Record<string, unknown>, type: string): number {
  let score = noComplexity
  if (functionTypes.has(type)) {
    score += decisionPoint
  }
  if (isDecisionNode(node, type)) {
    score += decisionPoint
  }
  return score
}

/** Return the child values Oxlint's visitor keys declare for a node. */
function keyedChildren(
  node: Record<string, unknown>,
  keys: readonly string[],
): readonly unknown[] {
  return keys.map((key) => node[key])
}

/** Score one value and return the children that still have to be visited. */
function complexityStep(value: unknown, scan: ComplexityScan): ComplexityStep {
  if (Array.isArray(value)) {
    return { score: noComplexity, children: value }
  }
  if (!isObject(value) || scan.seen.has(value)) {
    return emptyStep
  }
  scan.seen.add(value)
  const type = nodeType(value)
  if (type === undefined) {
    return emptyStep
  }
  return {
    score: nodeComplexity(value, type),
    children: keyedChildren(value, scan.visitorKeys[type] ?? []),
  }
}

function countComplexity(value: unknown, scan: ComplexityScan): number {
  const { children, score } = complexityStep(value, scan)
  let total = score
  for (const child of children) {
    total += countComplexity(child, scan)
  }
  return total
}

function calculateFileComplexity(
  value: unknown,
  visitorKeys: VisitorKeys,
): number {
  const scan: ComplexityScan = { seen: new WeakSet(), visitorKeys }
  return baseComplexity + countComplexity(value, scan)
}

function configuredMaximum(options: readonly unknown[]): number {
  const [option] = options
  if (typeof option === 'number') {
    return option
  }
  if (isObject(option) && !Array.isArray(option)) {
    const { max } = option
    if (typeof max === 'number') {
      return max
    }
  }
  return defaultMaximum
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
