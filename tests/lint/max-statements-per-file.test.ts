import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { maxStatementsPerFile } from '#tools/oxlint/rules/max-statements-per-file'

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

const maxStatements = { one: 1, two: 2 }

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      lang: 'ts',
    },
  },
})

ruleTester.run('max-statements-per-file', maxStatementsPerFile, {
  valid: [
    {
      name: 'file is exactly at the configured limit',
      code: 'const first = 1\nconst second = 2',
      options: [maxStatements.two],
    },
    {
      name: 'nested function statements are included',
      code: 'function value() { return 1 }',
      options: [maxStatements.two],
    },
    {
      name: 'object properties are not statements',
      code: 'const value = { first: 1, second: 2 }',
      options: [maxStatements.one],
    },
  ],
  invalid: [
    {
      name: 'reports a file above the limit',
      code: 'const first = 1\nconst second = 2\nconst third = 3',
      options: [maxStatements.two],
      errors: [
        {
          messageId: 'tooMany',
          data: { actual: 3, max: 2 },
        },
      ],
    },
    {
      name: 'counts statements inside functions',
      code: 'function value() { const first = 1; return first }',
      options: [maxStatements.two],
      errors: [
        {
          messageId: 'tooMany',
          data: { actual: 3, max: 2 },
        },
      ],
    },
  ],
})
