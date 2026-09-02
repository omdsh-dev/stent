/**
 * Require functions to occupy a minimum number of effective source lines.
 *
 * The rule is kept separate from the Stent plugin registration so each custom
 * rule can be tested and maintained independently.
 *
 * @module stent/oxlint/rules/min-function-lines
 */

import type { RuleTester } from 'oxlint/plugins-dev'

import {
  asNode,
  countLines,
  functionName,
} from '#tools/oxlint/utils/function-lines'

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

/* The node type is derived from the imported helper: eslint/no-duplicate-imports
   rejects a second `import type` statement for the same module, and
   import/consistent-type-specifier-style rejects inline type specifiers. */
type AstNode = NonNullable<ReturnType<typeof asNode>>

type FunctionKind = 'declaration' | 'expression' | 'method' | 'arrow'
type MinimumLines = number | false

interface RuleOptions {
  readonly minLines?: number
  readonly minimums?: Readonly<Partial<Record<FunctionKind, MinimumLines>>>
  readonly includeAnonymous?: boolean
  readonly skipBlankLines?: boolean
  readonly skipComments?: boolean
}

const defaultMinimumLines = 5

/** Classify a function so each syntax can have an independent threshold. */
function functionKind(node: AstNode): FunctionKind {
  if (node.type === 'FunctionDeclaration') {
    return 'declaration'
  }
  if (node.type === 'ArrowFunctionExpression') {
    return 'arrow'
  }
  const parent = asNode(node.parent)
  if (parent?.type === 'MethodDefinition' && asNode(parent.value) === node) {
    return 'method'
  }
  return 'expression'
}

/** Resolve the configured threshold; `false` disables one function syntax. */
function minimumFor(
  kind: FunctionKind,
  options: RuleOptions,
): number | undefined {
  const configured = options.minimums?.[kind]
  if (configured === false) {
    return undefined
  }
  return configured ?? options.minLines ?? defaultMinimumLines
}

function isRuleOptions(value: unknown): value is RuleOptions {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

/** Accept both the numeric shorthand and the object form of the options. */
function resolveOptions(raw: unknown): RuleOptions {
  if (typeof raw === 'number') {
    return { minLines: raw }
  }
  if (isRuleOptions(raw)) {
    return raw
  }
  return {}
}

/** Report one function whose body is shorter than its threshold. */
function checkFunction(
  node: AstNode,
  context: RuleContext,
  options: RuleOptions,
): void {
  const minLines = minimumFor(functionKind(node), options)
  if (minLines === undefined) {
    return
  }
  const name = functionName(node)
  if (name === undefined && options.includeAnonymous !== true) {
    return
  }
  const actual = countLines(node, context.sourceCode, {
    skipBlankLines: options.skipBlankLines ?? true,
    skipComments: options.skipComments ?? true,
  })
  if (actual < minLines) {
    context.report({
      node,
      messageId: 'tooShort',
      data: { name: name ?? '<anonymous>', actual, min: minLines },
    })
  }
}

const minFunctionLines: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require functions to contain a minimum number of effective source lines',
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
    const [raw] = context.options
    const options = resolveOptions(raw)

    return {
      FunctionDeclaration(node) {
        checkFunction(node, context, options)
      },
      FunctionExpression(node) {
        checkFunction(node, context, options)
      },
      ArrowFunctionExpression(node) {
        checkFunction(node, context, options)
      },
    }
  },
}

export { minFunctionLines }
