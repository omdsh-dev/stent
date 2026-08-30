import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { fileComplexity } from '../../tools/oxlint/rules/file-complexity.ts'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      lang: 'ts',
    },
  },
})

ruleTester.run('file-complexity', fileComplexity, {
  valid: [
    {
      name: 'a file starts with a baseline complexity of one',
      code: 'const value = 1',
      options: [1],
    },
    {
      name: 'a function contributes one complexity point',
      code: 'function value() { return 1 }',
      options: [2],
    },
    {
      name: 'nested functions are counted once each',
      code: 'function outer() { return () => 1 }',
      options: [3],
    },
    {
      name: 'switch defaults do not contribute a decision point',
      code: `function select(value) {
  switch (value) {
    case 1: return 1
    case 2: return 2
    default: return 0
  }
}`,
      options: [4],
    },
    {
      name: 'default parameters contribute a decision point',
      code: 'function value(input = 1) { return input }',
      options: [3],
    },
    {
      name: 'optional type properties do not contribute complexity',
      code: `interface Options { value?: number }
function value(options?: Options) {
  return options?.value ?? 0
}`,
      options: [4],
    },
    {
      name: 'catch clauses contribute a decision point',
      code: `function value() {
  try { return 1 } catch { return 0 }
}`,
      options: [3],
    },
  ],
  invalid: [
    {
      name: 'reports aggregate function and branch complexity',
      code: `function value(input) {
  if (input) {
    return 1
  }
  return 0
}`,
      options: [2],
      errors: [
        {
          messageId: 'tooComplex',
          data: { actual: 3, max: 2 },
        },
      ],
    },
    {
      name: 'logical assignments contribute a decision point',
      code: `function update(value) {
  value ||= 1
  return value
}`,
      options: [2],
      errors: [
        {
          messageId: 'tooComplex',
          data: { actual: 3, max: 2 },
        },
      ],
    },
    {
      name: 'accepts an object maximum option',
      code: 'const value = first && second',
      options: [{ max: 1 }],
      errors: [
        {
          messageId: 'tooComplex',
          data: { actual: 2, max: 1 },
        },
      ],
    },
  ],
})
