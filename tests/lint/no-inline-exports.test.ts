import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { noInlineExports } from '#tools/oxlint/rules/no-inline-exports'

/* Vitest's describe/it return collectors, so the tester receives void-returning
   adapters instead of the raw globals. */
const runSuite = describe
const runCase = it

RuleTester.describe = (name: string, body: () => void): void => {
  runSuite(name, body)
}
RuleTester.it = (name: string, body: () => void): void => {
  runCase(name, body)
}

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      lang: 'ts',
    },
  },
})

ruleTester.run('no-inline-exports', noInlineExports, {
  valid: [
    {
      name: 'exports a declaration through an export list',
      code: 'const value = 1\nexport { value }',
    },
    {
      name: 'exports a function through an export list',
      code: 'function value() { return 1 }\nexport { value }',
    },
    {
      name: 'allows a renamed export list entry',
      code: 'const value = 1\nexport { value as renamed }',
    },
    {
      name: 'allows a default entry in an export list',
      code: 'const value = 1\nexport { value as default }',
    },
    {
      name: 'allows a named re-export',
      code: "export { value } from './value.ts'",
    },
    {
      name: 'allows a type re-export',
      code: "export type { Value } from './value.ts'",
    },
  ],
  invalid: [
    {
      name: 'rejects an exported variable declaration',
      code: 'export const value = 1',
      errors: [{ messageId: 'inlineExport' }],
    },
    {
      name: 'rejects an exported function declaration',
      code: 'export function value() { return 1 }',
      errors: [{ messageId: 'inlineExport' }],
    },
    {
      name: 'rejects a default expression export',
      code: 'const value = 1\nexport default value',
      errors: [{ messageId: 'defaultExport' }],
    },
    {
      name: 'rejects a default function declaration',
      code: 'export default function value() { return 1 }',
      errors: [{ messageId: 'defaultExport' }],
    },
    {
      name: 'rejects a TypeScript interface declaration export',
      code: 'export interface Value { value: number }',
      errors: [{ messageId: 'inlineExport' }],
    },
  ],
})
