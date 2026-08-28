import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { maxStatementsPerFile } from '../../tools/oxlint/rules/max-statements-per-file.ts'

RuleTester.describe = describe
RuleTester.it = it

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
      options: [2],
    },
    {
      name: 'nested function statements are included',
      code: 'function value() { return 1 }',
      options: [2],
    },
    {
      name: 'object properties are not statements',
      code: 'const value = { first: 1, second: 2 }',
      options: [1],
    },
  ],
  invalid: [
    {
      name: 'reports a file above the limit',
      code: 'const first = 1\nconst second = 2\nconst third = 3',
      options: [2],
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
      options: [2],
      errors: [
        {
          messageId: 'tooMany',
          data: { actual: 3, max: 2 },
        },
      ],
    },
  ],
})
