/**
 * Project-local Oxlint plugin registration.
 *
 * Concrete rules live under `tools/oxlint/rules`; this module only gives them
 * the `stent` namespace consumed by Oxlint.
 *
 * @module stent/oxlint-plugin
 */

import { commentShorterThanFunction } from './rules/comment-shorter-than-function.ts'
import { minFunctionLines } from './rules/min-function-lines.ts'

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
    'min-function-lines': minFunctionLines,
  },
}

export default plugin
