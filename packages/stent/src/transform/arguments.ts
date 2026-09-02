/**
 * AST utilities for heuristically preserving `arguments` and allocating safe
 * names.
 *
 * Arrow functions do not create their own `arguments` binding, so the transform
 * scans their bodies before injecting a captured outer value. The structural
 * scan is not a complete lexical-scope resolver: computed property/method keys
 * are skipped, and local shadowing needs explicit care from callers. The
 * allocator shares the same program-wide identifier set to keep every injected
 * binding collision-free.
 *
 * @module @oh-my-dsh/stent/transform/arguments
 */

import type { Node, Pattern, Program } from 'estree'

import type { NameAllocator } from './ast-types.ts'

const AST_METADATA_KEYS = new Set(['loc', 'range', 'start', 'end'])
const argumentBoundaryTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
])

/** Per-file injected-name sets, keyed by the transformed Program node. */
const programNames = new WeakMap<Program, Set<string>>()

/** Suffix step used when a base identifier collides with the program. */
const NAME_SUFFIX_STEP = 1

/** Whether a value is an estree node for structural traversal. */
function isEstreeNode(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return typeof (value as { type?: unknown }).type === 'string'
}

/** Read one own structural field of an object as untyped data. */
function nodeField(node: object, key: string): unknown {
  if (!Object.hasOwn(node, key)) {
    return undefined
  }
  return Reflect.get(node, key)
}

/** Test whether a parameter pattern binds the identifier `arguments`. */
function patternBindsArguments(pattern: Pattern): boolean {
  switch (pattern.type) {
    case 'Identifier': {
      return pattern.name === 'arguments'
    }
    case 'AssignmentPattern': {
      return patternBindsArguments(pattern.left)
    }
    case 'RestElement': {
      return patternBindsArguments(pattern.argument)
    }
    case 'ObjectPattern': {
      return pattern.properties.some((property) => {
        if (property.type === 'RestElement') {
          return patternBindsArguments(property.argument)
        }
        return patternBindsArguments(property.value)
      })
    }
    case 'ArrayPattern': {
      return pattern.elements.some(
        (element) => element !== null && patternBindsArguments(element),
      )
    }
    case 'MemberExpression': {
      return false
    }
    default: {
      return false
    }
  }
}

/** Identify a nested function that owns or shadows `arguments`. */
function isArgumentBoundary(node: Node): boolean {
  if (argumentBoundaryTypes.has(node.type)) {
    return true
  }
  if (node.type !== 'ArrowFunctionExpression') {
    return false
  }
  return node.params.some(patternBindsArguments)
}

/** Exclude AST metadata and all Property/MethodDefinition keys from the walk. */
function shouldSkipArgumentKey(node: Node, key: string): boolean {
  if (AST_METADATA_KEYS.has(key)) {
    return true
  }
  if (key === 'key') {
    return node.type === 'Property' || node.type === 'MethodDefinition'
  }
  if (key !== 'property') {
    return false
  }
  return node.type === 'MemberExpression' && !node.computed
}

/** Rename one `arguments` identifier; reports that it was found. */
function mapArgumentIdentifier(
  node: Node & { name: string },
  name: string | undefined,
): boolean {
  if (name !== undefined) {
    node.name = name
  }
  return true
}

/** Read the non-metadata child values of one node, in key order. */
function childValues(node: Node): unknown[] {
  const values: unknown[] = []
  for (const key of Object.keys(node)) {
    if (!shouldSkipArgumentKey(node, key)) {
      values.push(nodeField(node, key))
    }
  }
  return values
}

/** Whether one child value holds an outer `arguments` reference, renaming it. */
function argumentHit(
  value: unknown,
  name: string | undefined,
  visit: (node: Node, name: string | undefined) => boolean,
): boolean {
  if (Array.isArray(value)) {
    let found = false
    for (const child of value) {
      if (isEstreeNode(child) && visit(child, name)) {
        found = true
      }
    }
    return found
  }
  if (isEstreeNode(value)) {
    return visit(value, name)
  }
  return false
}

/** Walk all child values, accumulating rewrite hits across every value. */
function argumentHits(
  values: readonly unknown[],
  name: string | undefined,
  visit: (node: Node, name: string | undefined) => boolean,
): boolean {
  let found = false
  for (const value of values) {
    if (argumentHit(value, name, visit)) {
      found = true
    }
  }
  return found
}

/**
 * Whether a node contains an identifier named `arguments` outside the
 * structural boundaries this helper recognizes, and optionally rewrites it to a
 * capture name. Nested ordinary functions and arrows whose parameters bind
 * `arguments` are boundaries; Property/MethodDefinition keys (computed or not)
 * and non-computed MemberExpression properties are skipped. This is not a full
 * lexical-scope analysis, so local declarations are not scope-resolved.
 *
 * @param node - The node to scan (and rewrite when `name` is given).
 * @param name - Capture name to rewrite `arguments` references to; omit to only
 *   detect references.
 * @returns True when at least one outer `arguments` reference was found.
 */
function mapOuterArguments(node: Node | undefined, name?: string): boolean {
  if (node === undefined) {
    return false
  }
  if (node.type === 'Identifier') {
    if (node.name !== 'arguments') {
      return false
    }
    return mapArgumentIdentifier(node, name)
  }
  if (isArgumentBoundary(node)) {
    return false
  }
  return argumentHits(childValues(node), name, mapOuterArguments)
}

/** Child nodes of one AST child position, in source order. */
function identifierChildValues(value: unknown): Node[] {
  const nodes: Node[] = []
  if (Array.isArray(value)) {
    for (const child of value) {
      if (isEstreeNode(child)) {
        nodes.push(child)
      }
    }
    return nodes
  }
  if (isEstreeNode(value)) {
    nodes.push(value)
  }
  return nodes
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
    if (!AST_METADATA_KEYS.has(key)) {
      for (const child of identifierChildValues(nodeField(node, key))) {
        collectIdentifiers(child, out)
      }
    }
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
function namesOf(program: Program): NameAllocator {
  let names = programNames.get(program)
  if (!names) {
    names = new Set<string>()
    collectIdentifiers(program, names)
    programNames.set(program, names)
  }
  return {
    unique(base: string): string {
      let name = base
      let index = 0
      while (names.has(name)) {
        index += NAME_SUFFIX_STEP
        name = `${base}_${index}`
      }
      names.add(name)
      return name
    },
  }
}

export { mapOuterArguments, namesOf }
