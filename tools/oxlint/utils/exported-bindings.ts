/**
 * Helpers for recognizing bindings exported through explicit export lists.
 *
 * @module stent/oxlint/utils/exported-bindings
 */

import { asNode, functionName } from './function-lines.ts'

/* The node and source-code types are derived from the imported helpers:
   eslint/no-duplicate-imports rejects a second `import type` statement for the
   same module, and import/consistent-type-specifier-style rejects inline type
   specifiers. */
type AstNode = NonNullable<ReturnType<typeof asNode>>
type VisitorKeys = Readonly<Record<string, readonly string[]>>

/** The part of Oxlint's source-code object an export scan reads. */
interface SourceCodeLike {
  readonly ast: unknown
  readonly visitorKeys: VisitorKeys
}

/** Mutable state shared by one export-name traversal. */
interface ExportScan {
  readonly visitorKeys: VisitorKeys
  readonly names: Set<string>
  readonly seen: WeakSet<object>
}

/** Report whether a declarator binds one of the exported names. */
function declaratorIsExported(
  declaration: unknown,
  exportedNames: ReadonlySet<string>,
): boolean {
  const id = asNode(asNode(declaration)?.id)
  if (id?.name === undefined) {
    return false
  }
  return exportedNames.has(id.name)
}

/** Report whether a variable declaration binds one of the exported names. */
function declaresExportedName(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): boolean {
  if (!('declarations' in node)) {
    return false
  }
  const { declarations } = node
  if (!Array.isArray(declarations)) {
    return false
  }
  for (const declaration of declarations) {
    if (declaratorIsExported(declaration, exportedNames)) {
      return true
    }
  }
  return false
}

function isExportedDeclaration(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): boolean {
  if (node.type === 'VariableDeclaration') {
    return declaresExportedName(node, exportedNames)
  }
  const name = functionName(node)
  return name !== undefined && exportedNames.has(name)
}

function isExportDeclaration(node: AstNode | undefined): boolean {
  return (
    node?.type === 'ExportNamedDeclaration'
    || node?.type === 'ExportDefaultDeclaration'
  )
}

function isFunctionNode(node: AstNode): boolean {
  return (
    node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
  )
}

/** Settle the export question at one ancestor, or defer to the next one. */
function ancestorVerdict(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): boolean | undefined {
  if (isExportDeclaration(node) || isExportedDeclaration(node, exportedNames)) {
    return true
  }
  if (isFunctionNode(node)) {
    return false
  }
  return undefined
}

function isExportedNode(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): boolean {
  if (isExportedDeclaration(node, exportedNames)) {
    return true
  }
  let current = asNode(node.parent)
  while (current !== undefined) {
    const verdict = ancestorVerdict(current, exportedNames)
    if (verdict !== undefined) {
      return verdict
    }
    current = asNode(current.parent)
  }
  return false
}

/** Return the local name an export specifier re-exports, when it has one. */
function localExportName(value: unknown): string | undefined {
  const node = asNode(value)
  if (node === undefined || !('local' in node)) {
    return undefined
  }
  return asNode(node.local)?.name
}

/** Record every local name listed by one `export { ... }` statement. */
function collectExportedSpecifierNames(
  node: AstNode,
  names: Set<string>,
): void {
  if (node.type !== 'ExportNamedDeclaration' || !('specifiers' in node)) {
    return
  }
  const { specifiers } = node
  if (!Array.isArray(specifiers)) {
    return
  }
  for (const specifier of specifiers) {
    const name = localExportName(specifier)
    if (name !== undefined) {
      names.add(name)
    }
  }
}

/** Return the child slots Oxlint's visitor keys declare for a node. */
function keyedChildren(node: AstNode, visitorKeys: VisitorKeys): unknown[] {
  const slots = new Map<string, unknown>(Object.entries(node))
  const keys = visitorKeys[node.type ?? ''] ?? []
  return keys.map((key) => slots.get(key))
}

/** Record the names of a value and return the children still to visit. */
function exportScanChildren(
  value: unknown,
  scan: ExportScan,
): readonly unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  const node = asNode(value)
  if (node === undefined || scan.seen.has(node)) {
    return []
  }
  scan.seen.add(node)
  collectExportedSpecifierNames(node, scan.names)
  return keyedChildren(node, scan.visitorKeys)
}

/** Walk one AST value, recording every explicitly exported local name. */
function collectExportedNames(value: unknown, scan: ExportScan): void {
  for (const child of exportScanChildren(value, scan)) {
    collectExportedNames(child, scan)
  }
}

function exportedNamesOf(sourceCode: SourceCodeLike): ReadonlySet<string> {
  const scan: ExportScan = {
    names: new Set<string>(),
    seen: new WeakSet(),
    visitorKeys: sourceCode.visitorKeys,
  }
  collectExportedNames(sourceCode.ast, scan)
  return scan.names
}

export { exportedNamesOf, isExportDeclaration, isExportedNode }
