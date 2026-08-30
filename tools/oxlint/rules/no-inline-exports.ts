/**
 * Require declarations to be exported through an explicit export list.
 *
 * This keeps definitions separate from the module's public surface. Re-exports
 * and `export { name }` lists remain valid; declarations such as `export const`
 * and `export default value` must be split into a declaration and an export
 * list.
 *
 * @module stent/oxlint/rules/no-inline-exports
 */

import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type RuleFactory = Extract<Rule, { create: (...args: never[]) => unknown }>
type VisitorObject = ReturnType<RuleFactory['create']>
type RuleContext = Parameters<RuleFactory['create']>[0]

const noInlineExports: Rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require declarations to use an explicit export list',
    },
    schema: [],
    messages: {
      inlineExport:
        'Declare the value first and export it with an explicit export list.',
      defaultExport:
        'Declare the value first and export it with an explicit export list.',
    },
  },

  create(context: RuleContext): VisitorObject {
    return {
      ExportNamedDeclaration(node) {
        if (node.declaration === null) {
          return
        }
        context.report({
          node,
          messageId: 'inlineExport',
        })
      },
      ExportDefaultDeclaration(node) {
        context.report({
          node,
          messageId: 'defaultExport',
        })
      },
    }
  },
}

export { noInlineExports }
