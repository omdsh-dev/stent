/**
 * Orchestrion matcher operations shared by the Node and browser adapters.
 * Matcher creation, module lookup, and source transformation are centralized
 * here. The upstream types expose `free()`, but current adapters keep each
 * matcher for its adapter lifetime; the Node loader frees selected transformers
 * it tracks when a snapshot changes or is disposed, while browser factories
 * have no explicit disposer.
 *
 * @module @oh-my-dsh/stent/transform/matcher
 */

import ts from 'typescript'

import type { StentInstrumentationConfig } from './config.ts'
import { orderInstrumentations } from './config.ts'
import { detectModuleType } from './identity.ts'
import type { InstrumentationMatcher, Transformer } from './orchestrion.ts'
import { createOrchestrion } from './orchestrion.ts'
import { registerStentTransform } from './transform.ts'
import type { StentBindingReport } from './types.ts'

/** A module with no pending rewritten nodes. */
const NO_PENDING_MODULES = 0

/** Upstream matcher with the Stent custom transform registered. */
type StentMatcher = InstrumentationMatcher

/** Upstream module transformer; it exposes `transform()` and `free()`. */
type StentTransformer = Transformer

/** Module identity the matcher needs for one module id. */
interface ModuleIdentity {
  name: string
  version: string
  path: string
}

/** Map a bundler module id to its package identity; `undefined` skips it. */
type IdentityResolver = (id: string) => ModuleIdentity | undefined

/** A transformed module: rewritten source plus optional source map and bindings. */
interface TransformOutput {
  code: string
  map?: string
  bindings?: StentBindingReport[]
}

/** Matcher-plus-counts context for one transform call. */
interface TransformContext {
  matcher: StentMatcher
  pending: Map<string, number>
  resolve: IdentityResolver
}

/** Resolve the transformer for one module id, or nothing when unmatched. */
function resolvedTransform(
  context: TransformContext,
  id: string,
): { transformer: StentTransformer; identity: ModuleIdentity } | undefined {
  const identity = context.resolve(id)
  if (identity === undefined) {
    return undefined
  }
  const transformer = context.matcher.getTransformer(
    identity.name,
    identity.version,
    identity.path,
  )
  if (transformer === undefined) {
    return undefined
  }
  return { transformer, identity }
}

/** Per-patch binding reports accumulated for one module. */
function bindingReports(
  pending: Map<string, number>,
  identity: ModuleIdentity,
): StentBindingReport[] {
  return [...pending].map(([patchId, nodes]) => ({
    patchId,
    module: identity.name,
    file: identity.path,
    nodes,
  }))
}

/** Build the output with source map and binding reports attached. */
function buildOutput(
  result: { code: string; map?: string },
  pending: Map<string, number>,
  identity: ModuleIdentity,
): TransformOutput {
  const output: TransformOutput = { code: result.code }
  if (result.map !== undefined) {
    output.map = result.map
  }
  if (pending.size > NO_PENDING_MODULES) {
    output.bindings = bindingReports(pending, identity)
  }
  return output
}

/** Emit TypeScript/JSX as JavaScript for the AST transformer (emit only). */
function stripTypes(code: string, fileName: string): string {
  return ts.transpileModule(code, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      /* JSX must be emitted as calls (the parser cannot read JSX syntax). The
         automatic runtime keeps the output self-contained: modern-transform
         sources get a `react/jsx-runtime` import instead of an undefined
         `React`; classic-runtime sources keep their explicit calls. */
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
}

/** Transpile TypeScript/TSX sources before the JavaScript transformer runs. */
function transformedSource(code: string, id: string): string {
  if (/\.tsx?$/u.test(id)) {
    return stripTypes(code, id)
  }
  return code
}

/**
 * Order an instrumentation snapshot for the Orchestrion matcher and wire.
 *
 * @param instrumentations - Expanded configs to copy and sort.
 * @returns A new ascending-priority array.
 */
function orderStentInstrumentations(
  instrumentations: readonly StentInstrumentationConfig[],
): StentInstrumentationConfig[] {
  return orderInstrumentations(instrumentations)
}

/**
 * Create a matcher from an instrumentation snapshot and register `'stent'`.
 *
 * @param instrumentations - Expanded configs; copied and ordered before
 *   creation.
 * @param onMatch - Optional callback once per successfully rewritten AST node
 *   during source transformation.
 * @returns A matcher with the Stent transform installed. Direct callers may
 *   call upstream `free()`; current adapters retain their matcher snapshot as
 *   described in the module documentation.
 */
function createStentMatcher(
  instrumentations: readonly StentInstrumentationConfig[],
  onMatch?: (patchId: string) => void,
): StentMatcher {
  const matcher = createOrchestrion(
    orderStentInstrumentations(instrumentations),
  )
  registerStentTransform(matcher, onMatch)
  return matcher
}

/**
 * Select a transformer for a package identity, or return `undefined` on no
 * match.
 *
 * @param matcher - Matcher created by {@link createStentMatcher}.
 * @param moduleName - Resolved package name.
 * @param version - Resolved package version.
 * @param filePath - Package-relative path.
 * @returns The upstream transformer, or `undefined`; direct callers may free
 *   it, while the Node loader retains its cached transformers until snapshot
 *   cleanup.
 */
function getStentTransformer(
  matcher: StentMatcher,
  moduleName: string,
  version: string,
  filePath: string,
): StentTransformer | undefined {
  return matcher.getTransformer(moduleName, version, filePath)
}

/**
 * Transform source with a selected upstream transformer.
 *
 * @param transformer - Transformer selected for the current module.
 * @param source - JavaScript source; TypeScript must be emitted first.
 * @param moduleType - Module format passed to Orchestrion.
 * @returns Rewritten source and an optional source map.
 * @throws When called, propagates parser, selector, and injection errors from
 *   Orchestrion.
 */
function transformStentSource(
  transformer: StentTransformer,
  source: string,
  moduleType: 'esm' | 'cjs',
): { code: string; map?: string } {
  const result = transformer.transform(source, moduleType)
  if (result.map === undefined) {
    return { code: result.code }
  }
  return { code: result.code, map: result.map }
}

/** Run one transform call for a resolved module id. */
function transformModuleState(
  code: string,
  id: string,
  context: TransformContext,
): TransformOutput | null {
  const selection = resolvedTransform(context, id)
  if (selection === undefined) {
    return null
  }
  const source = transformedSource(code, id)
  context.pending.clear()
  const result = transformStentSource(
    selection.transformer,
    source,
    detectModuleType(id),
  )
  return buildOutput(result, context.pending, selection.identity)
}

export {
  orderStentInstrumentations,
  createStentMatcher,
  getStentTransformer,
  transformStentSource,
  transformModuleState,
}
export type {
  StentMatcher,
  StentTransformer,
  ModuleIdentity,
  IdentityResolver,
  TransformOutput,
}
