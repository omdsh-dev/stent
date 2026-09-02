import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { commentShorterThanFunction } from '#tools/oxlint/rules/comment-shorter-than-function'

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

ruleTester.run('comment-shorter-than-function', commentShorterThanFunction, {
  valid: [
    {
      name: 'function without comments',
      code: 'function valid() {\n  const value = 1\n  return value\n}',
    },
    {
      name: 'documentation is shorter than implementation',
      code: '/**\n * Resolve the value.\n */\nfunction valid() {\n  const value = 1\n  const result = value + 1\n  return result\n}',
    },
    {
      name: 'file header separated by a blank line is not associated',
      code: '// Module overview.\n// More details.\n\nfunction valid() {\n  return 1\n}',
    },
    {
      name: 'comment before another declaration is not associated',
      code: '// A constant.\nconst value = 1\nfunction valid() {\n  return value\n}',
    },
    {
      name: 'inline trailing comment is ignored',
      code: 'const value = 1 // inline value\nfunction valid() {\n  return value\n}',
    },
    {
      name: 'function-body comments are not leading comments',
      code: 'function valid() {\n  // explain the value\n  return 1\n}',
    },
    {
      name: 'lint directives do not count as documentation',
      code: '// eslint-disable-next-line no-console\nfunction valid() {\n  return 1\n}',
    },
    {
      name: 'multiline compiler directives do not count as documentation',
      code: '/**\n * @ts-ignore\n */\nfunction valid() {\n  return 1\n}',
    },
    {
      name: 'separator-only documentation does not count',
      code: '/**\n * ----------------\n */\nfunction valid() {\n  return 1\n}',
    },
    {
      name: 'exported functions are skipped by default',
      code: '/**\n * First line.\n * Second line.\n */\nexport function valid() {\n  return 1\n}',
    },
    {
      name: 'exported variable-bound arrow is skipped by default',
      code: '/**\n * First line.\n * Second line.\n */\nexport const valid = () => {\n  const value = 1\n  return value\n}',
    },
    {
      name: 'explicitly listed function is skipped by default',
      code: '/**\n * First line.\n * Second line.\n */\nfunction valid() {\n  return 1\n}\nexport { valid }',
    },
    {
      name: 'explicitly listed arrow is skipped by default',
      code: '/**\n * First line.\n * Second line.\n */\nconst valid = () => {\n  const value = 1\n  return value\n}\nexport { valid }',
    },
    {
      name: 'class method with shorter documentation',
      code: 'class Example {\n  /** Describe the method. */\n  valid() {\n    const value = 1\n    return value\n  }\n}',
    },
    {
      name: 'anonymous callback is skipped by default',
      code: 'items.map(/** callback */ item => item.id)',
    },
    {
      name: 'contiguous comments stop at a blank line',
      code: '// Associated line.\n\n// Unrelated line.\nfunction valid() {\n  const value = 1\n  return value\n}',
    },
  ],
  invalid: [
    {
      name: 'equal documentation and implementation lines',
      code: '/**\n * Explain the first behavior.\n * Explain the second behavior.\n */\nfunction equal() { return 1\n}',
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'equal', comments: 2, code: 2 },
        },
      ],
    },
    {
      name: 'comment delimiters can be counted explicitly',
      code: '/**\n * Explain the function.\n */\nfunction delimiters() { return 1\n}',
      options: [{ countCommentDelimiters: true }],
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'delimiters', comments: 3, code: 2 },
        },
      ],
    },
    {
      name: 'documentation is longer than implementation',
      code: '// First explanation.\n// Second explanation.\n// Third explanation.\nfunction longer() { return 1\n}',
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'longer', comments: 3, code: 2 },
        },
      ],
    },
    {
      name: 'contiguous line and block comments are combined',
      code: '// Explain the first part.\n/**\n * Explain the second part.\n */\nfunction combined() { return 1\n}',
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'combined', comments: 2, code: 2 },
        },
      ],
    },
    {
      name: 'variable-bound function uses the declaration comment anchor',
      code: '/**\n * Explain the function.\n * Explain its result.\n */\nconst variable = function () { return 1\n}',
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'variable', comments: 2, code: 2 },
        },
      ],
    },
    {
      name: 'class method documentation is checked',
      code: 'class Example {\n  /**\n   * Explain the method.\n   * Explain its result.\n   */\n  method() { return 1\n  }\n}',
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'method', comments: 2, code: 2 },
        },
      ],
    },
    {
      name: 'exported function can be included explicitly',
      code: '/**\n * First explanation.\n * Second explanation.\n */\nexport function exported() { return 1\n}',
      options: [{ includeExported: true }],
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: 'exported', comments: 2, code: 2 },
        },
      ],
    },
    {
      name: 'exported default anonymous arrow can be included explicitly',
      code: '/**\n * First explanation.\n * Second explanation.\n */\nexport default () => { return 1\n}',
      options: [{ includeAnonymous: true, includeExported: true }],
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: '<anonymous>', comments: 2, code: 2 },
        },
      ],
    },
    {
      name: 'anonymous function can be included explicitly',
      code: 'items.map(\n  /**\n   * First explanation.\n   * Second explanation.\n   */\n  function (item) { return item.id\n  },\n)',
      options: [{ includeAnonymous: true }],
      errors: [
        {
          messageId: 'commentNotShorter',
          data: { name: '<anonymous>', comments: 2, code: 2 },
        },
      ],
    },
  ],
})
