import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { minFunctionLines } from '../../tools/oxlint/stent-plugin.ts'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      lang: 'ts',
    },
  },
})

ruleTester.run('min-function-lines', minFunctionLines, {
  valid: [
    {
      name: 'function at the configured minimum',
      code: 'function valid() {\n  return 1\n}',
    },
    {
      name: 'anonymous callback is ignored by default',
      code: 'items.map(item => item.id)',
    },
    {
      name: 'object-literal callback is ignored by default',
      code: 'const schema = { resolve: value => value !== null }',
    },
    {
      name: 'blank and comment-only lines do not count',
      code: 'function valid() {\n  // explanatory comment\n\n  return 1\n}',
    },
    {
      name: 'concise arrow functions can be excluded',
      code: 'const valid = () => 1',
      options: [{ includeExpressionBodies: false }],
    },
    {
      name: 'numeric option can lower the threshold',
      code: 'const valid = () => 1',
      options: [1],
    },
  ],
  invalid: [
    {
      name: 'short function declaration',
      code: 'function short() { return 1 }',
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 3 } }],
    },
    {
      name: 'short named arrow function',
      code: 'const short = () => 1',
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 3 } }],
    },
    {
      name: 'anonymous functions can be opted in',
      code: 'items.map(function (item) { return item.id })',
      options: [{ includeAnonymous: true }],
      errors: [{ messageId: 'tooShort', data: { name: '<anonymous>', actual: 1, min: 3 } }],
    },
  ],
})
