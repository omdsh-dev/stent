import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { fileComplexity } from '#tools/oxlint/rules/file-complexity'

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

const maxComplexity = { one: 1, two: 2, three: 3, four: 4 }

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
      options: [maxComplexity.one],
    },
    {
      name: 'a function contributes one complexity point',
      code: 'function value() { return 1 }',
      options: [maxComplexity.two],
    },
    {
      name: 'nested functions are counted once each',
      code: 'function outer() { return () => 1 }',
      options: [maxComplexity.three],
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
      options: [maxComplexity.four],
    },
    {
      name: 'default parameters contribute a decision point',
      code: 'function value(input = 1) { return input }',
      options: [maxComplexity.three],
    },
    {
      name: 'optional type properties do not contribute complexity',
      code: `interface Options { value?: number }
function value(options?: Options) {
  return options?.value ?? 0
}`,
      options: [maxComplexity.four],
    },
    {
      name: 'catch clauses contribute a decision point',
      code: `function value() {
  try { return 1 } catch { return 0 }
}`,
      options: [maxComplexity.three],
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
      options: [maxComplexity.two],
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
      options: [maxComplexity.two],
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
