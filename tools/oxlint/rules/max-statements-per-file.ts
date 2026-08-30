/**
 * Enforce a maximum number of executable statements and declarations per file.
 *
 * This is intentionally separate from ESLint's `max-statements`, which scopes
 * its count to individual functions.
 *
 * @module stent/oxlint/rules/max-statements-per-file
 */

import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type VisitorObject = ReturnType<RuleFactory['create']>
type RuleContext = Parameters<RuleFactory['create']>[0]

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

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object') {
    return false
  }
  return value !== null
}

function countArrayStatements(
  values: unknown[],
  seen: WeakSet<object>,
): number {
  let count = 0
  for (const child of values) {
    count += countStatements(child, seen)
  }
  return count
}

function nodeType(value: Record<string, unknown>): string | undefined {
  const type = value.type
  if (typeof type !== 'string') {
    return undefined
  }
  return type
}

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

function countNodeChildren(
  node: Record<string, unknown>,
  seen: WeakSet<object>,
  type: string | undefined,
): number {
  let count = 0
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') {
      continue
    }
    count += countStatements(child, seen, !isModuleDeclarationKey(key, type))
  }
  return count
}

function countStatements(
  value: unknown,
  seen = new WeakSet(),
  includeSelf = true,
): number {
  if (Array.isArray(value)) {
    return countArrayStatements(value, seen)
  }
  if (!isObject(value) || seen.has(value)) {
    return 0
  }
  seen.add(value)
  const node = value
  const type = nodeType(node)
  const own =
    includeSelf && type !== undefined && statementTypes.has(type) ? 1 : 0
  return own + countNodeChildren(node, seen, type)
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
  return 220
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
        const actual = countStatements(node)
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
