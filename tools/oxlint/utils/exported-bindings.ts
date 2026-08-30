/**
 * Helpers for recognizing bindings exported through explicit export lists.
 *
 * @module stent/oxlint/utils/exported-bindings
 */

import {
  asNode,
  functionName,
  type AstNode,
  type SourceCode,
} from './function-lines.ts'

function isExportedDeclaration(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): boolean {
  if (node.type === 'VariableDeclaration') {
    const declarations = (node as unknown as { declarations?: unknown })
      .declarations
    if (!Array.isArray(declarations)) {
      return false
    }
    for (const declaration of declarations) {
      const entry = asNode(declaration)
      const id = asNode(entry?.id)
      if (id?.name !== undefined && exportedNames.has(id.name)) {
        return true
      }
    }
    return false
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

function isExportedNode(
  node: AstNode,
  exportedNames: ReadonlySet<string>,
): boolean {
  if (isExportedDeclaration(node, exportedNames)) {
    return true
  }
  let current = asNode(node.parent)
  while (current !== undefined) {
    if (isExportDeclaration(current)) {
      return true
    }
    if (isExportedDeclaration(current, exportedNames)) {
      return true
    }
    if (isFunctionNode(current)) {
      return false
    }
    current = asNode(current.parent)
  }
  return false
}

function localExportName(value: unknown): string | undefined {
  const node = asNode(value)
  if (node === undefined) {
    return undefined
  }
  const local = asNode((node as { local?: unknown }).local)
  return local?.name
}

type VisitorKeys = Readonly<Record<string, readonly string[]>>

function collectExportedSpecifierNames(
  node: AstNode,
  names: Set<string>,
): void {
  if (node.type !== 'ExportNamedDeclaration') {
    return
  }
  const specifiers = (node as { specifiers?: unknown }).specifiers
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

function collectExportedNameArray(
  values: unknown[],
  visitorKeys: VisitorKeys,
  names: Set<string>,
  seen: WeakSet<object>,
): void {
  for (const child of values) {
    collectExportedNames(child, visitorKeys, names, seen)
  }
}

function collectExportedNames(
  value: unknown,
  visitorKeys: VisitorKeys,
  names: Set<string>,
  seen: WeakSet<object>,
): void {
  if (Array.isArray(value)) {
    collectExportedNameArray(value, visitorKeys, names, seen)
    return
  }
  const node = asNode(value)
  if (node === undefined) {
    return
  }
  if (seen.has(node)) {
    return
  }
  seen.add(node)
  collectExportedSpecifierNames(node, names)
  const keys = visitorKeys[node.type ?? ''] ?? []
  for (const key of keys) {
    const child = (node as unknown as Record<string, unknown>)[key]
    collectExportedNames(child, visitorKeys, names, seen)
  }
}

function exportedNamesOf(sourceCode: SourceCode): ReadonlySet<string> {
  const names = new Set<string>()
  const seen = new WeakSet()
  collectExportedNames(sourceCode.ast, sourceCode.visitorKeys, names, seen)
  return names
}

export { exportedNamesOf, isExportDeclaration, isExportedNode }
