import type { Node, Pattern, Program } from 'estree'

import type { NameAllocator } from './ast-types.ts'

/**
 * Whether a node references the enclosing scope's `arguments` object, and
 * optionally rewrites those references to a capture name. Nested non-arrow
 * functions own their `arguments` and are not descended into; nested arrows
 * still resolve lexically and are descended into. Property keys and
 * non-computed member properties are not references.
 *
 * @param node - The node to scan (and rewrite when `name` is given).
 * @param name - Capture name to rewrite `arguments` references to; omit to only
 *   detect references.
 * @returns True when at least one outer `arguments` reference was found.
 */
export function mapOuterArguments(
  node: Node | undefined,
  name: string | undefined,
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'Identifier') {
    if (node.name !== 'arguments') {
      return false
    }
    if (name !== undefined) {
      node.name = name
    }
    return true
  }
  if (
    node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || (node.type === 'ArrowFunctionExpression'
      && node.params.some(patternBindsArguments))
  ) {
    return false
  }
  let found = false
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') {
      continue
    }
    // Property keys and non-computed member properties are not references.
    if (
      key === 'key'
      && (node.type === 'Property' || node.type === 'MethodDefinition')
    ) {
      continue
    }
    if (
      key === 'property'
      && node.type === 'MemberExpression'
      && !node.computed
    ) {
      continue
    }
    const value = (node as unknown as Record<string, unknown>)[key]
    if (mapOuterArgumentsValue(value, name)) {
      found = true
    }
  }
  return found
}

/** Scan an AST child value for enclosing-scope `arguments` references. */
function mapOuterArgumentsValue(
  value: unknown,
  name: string | undefined,
): boolean {
  if (Array.isArray(value)) {
    let found = false
    for (const child of value) {
      if (
        typeof child === 'object'
        && child !== null
        && mapOuterArguments(child as Node, name)
      ) {
        found = true
      }
    }
    return found
  }
  if (typeof value === 'object' && value !== null) {
    return mapOuterArguments(value as Node, name)
  }
  return false
}

function patternBindsArguments(pattern: Pattern): boolean {
  switch (pattern.type) {
    case 'Identifier':
      return pattern.name === 'arguments'
    case 'AssignmentPattern':
      return patternBindsArguments(pattern.left)
    case 'RestElement':
      return patternBindsArguments(pattern.argument)
    case 'ObjectPattern':
      return pattern.properties.some((property) =>
        property.type === 'RestElement'
          ? patternBindsArguments(property.argument)
          : patternBindsArguments(property.value),
      )
    case 'ArrayPattern':
      return pattern.elements.some(
        (element) => element !== null && patternBindsArguments(element),
      )
    default:
      return false
  }
}

/**
 * Per-program identifier allocator. The name set is seeded with every
 * identifier of the program on first use, so an injected name can never shadow
 * a reference the traced body keeps resolving.
 *
 * @param program - The matched file's Program node.
 * @returns A `unique(base)` allocator for that file.
 */
export function namesOf(program: Program): NameAllocator {
  let names = programNames.get(program)
  if (!names) {
    names = new Set<string>()
    collectIdentifiers(program, names)
    programNames.set(program, names)
  }
  return {
    unique(base: string): string {
      let name = base
      let i = 0
      while (names.has(name)) {
        name = `${base}_${++i}`
      }
      names.add(name)
      return name
    },
  }
}

/**
 * Collect every identifier name in a node into the given set. The walk is
 * deliberately broad (property keys, labels, and member properties included):
 * over-conservative renaming is safe, while a missed variable reference would
 * silently change what the moved body resolves.
 *
 * @param node - The AST node to walk.
 * @param out - The set receiving identifier names.
 */
function collectIdentifiers(node: Node, out: Set<string>): void {
  if (node.type === 'Identifier') {
    out.add(node.name)
    return
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') {
      continue
    }
    const value = (node as unknown as Record<string, unknown>)[key]
    collectIdentifierValue(value, out)
  }
}

/** Collect identifiers from an AST child value. */
function collectIdentifierValue(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      if (typeof child === 'object' && child !== null) {
        collectIdentifiers(child as Node, out)
      }
    }
    return
  }
  if (typeof value === 'object' && value !== null) {
    collectIdentifiers(value as Node, out)
  }
}

/** Per-file injected-name sets, keyed by the transformed Program node. */
const programNames = new WeakMap<Program, Set<string>>()
