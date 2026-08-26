/**
 * Stent's public target-query alias for the Orchestrion function selector.
 * Keeping the third-party type import in `transform` prevents runtime and
 * service modules from depending on the code-transformer package directly.
 * @module @oh-my-dsh/stent/transform/types
 */

import type { FunctionQuery } from './orchestrion.ts'

export type StentFunctionQuery = FunctionQuery
