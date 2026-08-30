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
  type AstNode,
  type RuleContext,
} from '../utils/function-lines.ts'

type Rule = Parameters<RuleTester['run']>[1]
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type VisitorObject = ReturnType<RuleFactory['create']>

type FunctionKind = 'declaration' | 'expression' | 'method' | 'arrow'
type MinimumLines = number | false

interface RuleOptions {
  minLines?: number
  minimums?: Partial<Record<FunctionKind, MinimumLines>>
  includeAnonymous?: boolean
  skipBlankLines?: boolean
  skipComments?: boolean
}

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
  return configured ?? options.minLines ?? 5
}

function isRuleOptions(value: unknown): value is RuleOptions {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
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
    const raw = context.options[0]
    let options: RuleOptions
    if (typeof raw === 'number') {
      options = { minLines: raw }
    } else if (isRuleOptions(raw)) {
      options = raw
    } else {
      options = {}
    }
    const includeAnonymous = options.includeAnonymous ?? false
    const skipBlankLines = options.skipBlankLines ?? true
    const skipComments = options.skipComments ?? true

    function check(node: AstNode): void {
      const minLines = minimumFor(functionKind(node), options)
      if (minLines === undefined) {
        return
      }
      const name = functionName(node)
      if (name === undefined && !includeAnonymous) {
        return
      }
      const actual = countLines(node, context.sourceCode, {
        skipBlankLines,
        skipComments,
      })
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

export { minFunctionLines }
