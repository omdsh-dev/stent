/**
 * Enforce a maximum number of executable statements and declarations per file.
 *
 * This is intentionally separate from ESLint's `max-statements`, which scopes
 * its count to individual functions.
 *
 * @module stent/oxlint/rules/max-statements-per-file
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

const statementTypes = new Set([
  'BreakStatement',
  'ClassDeclaration',
  'ContinueStatement',
  'DebuggerStatement',
  'DoWhileStatement',
  'EmptyStatement',
  'ExpressionStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'FunctionDeclaration',
  'IfStatement',
  'LabeledStatement',
  'ReturnStatement',
  'SwitchStatement',
  'ThrowStatement',
  'TryStatement',
  'VariableDeclaration',
  'WhileStatement',
  'WithStatement',
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'TSDeclareFunction',
  'TSEnumDeclaration',
  'TSExportAssignment',
  'TSImportEqualsDeclaration',
  'TSInterfaceDeclaration',
  'TSModuleDeclaration',
  'TSNamespaceExportDeclaration',
  'TSTypeAliasDeclaration',
])

const moduleDeclarationTypes = new Set([
  'ExportAllDeclaration',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
])

const defaultMaximum = 220
const oneStatement = 1
const noStatements = 0

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object') {
    return false
  }
  return value !== null
}

function nodeType(value: Record<string, unknown>): string | undefined {
  const { type } = value
  if (typeof type !== 'string') {
    return undefined
  }
  return type
}

/**
 * Report whether a key holds the declaration of a module statement, whose own
 * statement is already counted through its export wrapper.
 */
function isModuleDeclarationKey(
  key: string,
  type: string | undefined,
): boolean {
  if (key !== 'declaration') {
    return false
  }
  if (type === undefined) {
    return false
  }
  return moduleDeclarationTypes.has(type)
}

/** Return the statement one node contributes on its own. */
function ownStatements(type: string | undefined, includeSelf: boolean): number {
  if (!includeSelf || type === undefined) {
    return noStatements
  }
  if (statementTypes.has(type)) {
    return oneStatement
  }
  return noStatements
}

function countStatements(
  value: unknown,
  seen: WeakSet<object>,
  includeSelf: boolean,
): number {
  if (!isObject(value) || seen.has(value)) {
    return noStatements
  }
  seen.add(value)
  const type = nodeType(value)
  let count = ownStatements(type, includeSelf)
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'parent') {
      count += countStatements(child, seen, !isModuleDeclarationKey(key, type))
    }
  }
  return count
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

const maxStatementsPerFile: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce a maximum number of statements per file',
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
      tooMany: 'File has {{actual}} statements; maximum is {{max}}.',
    },
  },

  create(context: RuleContext): VisitorObject {
    const max = configuredMaximum(context.options)
    return {
      Program(node) {
        const actual = countStatements(node, new WeakSet(), true)
        if (actual > max) {
          context.report({
            node,
            messageId: 'tooMany',
            data: { actual, max },
          })
        }
      },
    }
  },
}

export { maxStatementsPerFile }
