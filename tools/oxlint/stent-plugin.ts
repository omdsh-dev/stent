/**
 * Project-local Oxlint plugin registration.
 *
 * Concrete rules live under `tools/oxlint/rules`; this module only gives them
 * the `stent` namespace consumed by Oxlint.
 *
 * @module stent/oxlint-plugin
 */

import { commentShorterThanFunction } from './rules/comment-shorter-than-function.ts'
import { fileComplexity } from './rules/file-complexity.ts'
import { maxStatementsPerFile } from './rules/max-statements-per-file.ts'
import { minFunctionLines } from './rules/min-function-lines.ts'
import { noInlineExports } from './rules/no-inline-exports.ts'

type Rule = typeof minFunctionLines
type OxlintPlugin = {
  meta: {
    name: string
  }
  rules: Record<string, Rule>
}

const plugin: OxlintPlugin = {
  meta: {
    name: 'stent',
  },
  rules: {
    'comment-shorter-than-function': commentShorterThanFunction,
    'file-complexity': fileComplexity,
    'max-statements-per-file': maxStatementsPerFile,
    'min-function-lines': minFunctionLines,
    'no-inline-exports': noInlineExports,
  },
}

export { plugin as default }
