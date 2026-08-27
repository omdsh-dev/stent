import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { minFunctionLines } from '../../tools/oxlint/rules/min-function-lines.ts'

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
      code: 'function valid() {\n  const value = 1\n  const result = value + 1\n  return result\n}',
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
      code: 'function valid() {\n  // explanatory comment\n\n  const value = 1\n  const result = value + 1\n  return result\n}',
    },
    {
      name: 'arrow functions can be excluded by syntax',
      code: 'const valid = () => 1',
      options: [{ minimums: { arrow: false } }],
    },
    {
      name: 'method can use a lower threshold',
      code: 'class Example { valid() {\n  return 1 } }',
      options: [{ minimums: { method: 2 } }],
    },
    {
      name: 'arrow can use an explicit threshold',
      code: 'const valid = () => {\n  return 1\n}',
      options: [{ minimums: { arrow: 3 } }],
    },
    {
      name: 'numeric option can lower the threshold',
      code: 'const valid = function () { return 1 }',
      options: [1],
    },
  ],
  invalid: [
    {
      name: 'short function declaration',
      code: 'function short() { return 1 }',
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 5 } }],
    },
    {
      name: 'short named arrow function',
      code: 'const short = () => 1',
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 5 } }],
    },
    {
      name: 'short function expression with its own threshold',
      code: 'const short = function () { return 1 }',
      options: [{ minimums: { expression: 2 } }],
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 2 } }],
    },
    {
      name: 'short class method',
      code: 'class Example { short() { return 1 } }',
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 5 } }],
    },
    {
      name: 'method threshold can reject a two-line body',
      code: 'class Example { short() {\n  return 1 } }',
      options: [{ minimums: { method: 3 } }],
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 2, min: 3 } }],
    },
    {
      name: 'arrow threshold can reject a concise body',
      code: 'const short = () => 1',
      options: [{ minimums: { arrow: 3 } }],
      errors: [{ messageId: 'tooShort', data: { name: 'short', actual: 1, min: 3 } }],
    },
    {
      name: 'anonymous functions can be opted in',
      code: 'items.map(function (item) { return item.id })',
      options: [{ includeAnonymous: true }],
      errors: [{ messageId: 'tooShort', data: { name: '<anonymous>', actual: 1, min: 5 } }],
    },
  ],
})
