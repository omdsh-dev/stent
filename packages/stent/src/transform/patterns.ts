/**
 * Match supported function-shaped AST nodes and rebuild parameter patterns.
 *
 * The matcher normalizes methods and object properties to their function value.
 * Pattern conversion is used only for arrow functions, where the transform must
 * reconstruct an argument array without an own `arguments` object.
 *
 * @module @oh-my-dsh/stent/transform/patterns
 */

import type {
  ArrayPattern,
  ArrowFunctionExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectPattern,
  Pattern,
  SpreadElement,
} from 'estree'

import type { MatchedFunction } from './ast-types.ts'

/** A function-like estree node after method/property unwrapping. */
type FunctionNode =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunctionExpression

/**
 * Unwrap a method or object property to its function value.
 *
 * @param node - The selected AST node.
 * @returns The node itself when it is already function-shaped, its `value` for
 *   MethodDefinition/Property nodes, or `undefined` for any other shape.
 */
function functionValue(node: Node): FunctionNode | undefined {
  let fn: Node = node
  if (node.type === 'MethodDefinition' || node.type === 'Property') {
    fn = node.value
  }
  if (
    fn.type !== 'FunctionDeclaration'
    && fn.type !== 'FunctionExpression'
    && fn.type !== 'ArrowFunctionExpression'
  ) {
    return undefined
  }
  return fn
}

/**
 * Return whether the matcher selected a class constructor.
 *
 * @param node - The selected AST node.
 * @param parent - The selected node's parent in the matcher walk.
 * @returns Whether either node represents a constructor method.
 */
function isConstructorTarget(node: Node, parent: Node): boolean {
  return (
    (node.type === 'MethodDefinition' && node.kind === 'constructor')
    || (parent.type === 'MethodDefinition' && parent.kind === 'constructor')
  )
}

/** Patterns bound by one object-pattern property list. */
function objectNestedPatterns(pattern: ObjectPattern): Pattern[] {
  const nested: Pattern[] = []
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') {
      nested.push(property.argument)
    } else {
      nested.push(property.value)
    }
  }
  return nested
}

/** Patterns a bound pattern directly nests (empty for leaves). */
function nestedPatterns(pattern: Pattern): Pattern[] {
  switch (pattern.type) {
    case 'Identifier': {
      return []
    }
    case 'AssignmentPattern': {
      return [pattern.left]
    }
    case 'RestElement': {
      return [pattern.argument]
    }
    case 'ObjectPattern': {
      return objectNestedPatterns(pattern)
    }
    case 'ArrayPattern': {
      return pattern.elements.filter(
        (element): element is Pattern => element !== null,
      )
    }
    case 'MemberExpression': {
      return []
    }
    default: {
      return []
    }
  }
}

/** Recursive helper for {@link patternNames}. */
function collectPatternNames(pattern: Pattern, out: Set<string>): void {
  if (pattern.type === 'Identifier') {
    out.add(pattern.name)
  }
  for (const nested of nestedPatterns(pattern)) {
    collectPatternNames(nested, out)
  }
}

/**
 * Collect every name a parameter pattern binds.
 *
 * @param pattern - A parameter pattern.
 * @returns The set of bound names.
 */
function patternNames(pattern: Pattern): Set<string> {
  const out = new Set<string>()
  collectPatternNames(pattern, out)
  return out
}

/** Whether any parameter binds the identifier `arguments`. */
function bindsArgumentsName(params: Pattern[]): boolean {
  for (const param of params) {
    if (patternNames(param).has('arguments')) {
      return true
    }
  }
  return false
}

/**
 * Extract a transformable function from the matched node. Class methods and
 * object properties are unwrapped to their `value`; unsupported nodes return
 * `undefined`. An arrow whose parameter pattern binds `arguments` also returns
 * `undefined` so the transform does not guess which binding its body means.
 */
function matchFunction(node: Node): MatchedFunction | undefined {
  const functionNode = functionValue(node)
  if (functionNode === undefined) {
    return undefined
  }
  const arrow = functionNode.type === 'ArrowFunctionExpression'
  /* A parameter literally named `arguments` would shadow the outer `arguments`
     object the body may reference; skip rather than guess which one the body
     means. All other pattern shapes (rest, defaults, destructuring) work. */
  if (arrow && bindsArgumentsName(functionNode.params)) {
    return undefined
  }
  return {
    node: functionNode,
    arrow,
    body: functionNode.body,
    params: functionNode.params,
    async: functionNode.async ?? false,
    generator: functionNode.generator ?? false,
  }
}

/** Rebuilt value for pattern shapes that cannot produce a real value. */
const UNSUPPORTED_PATTERN_VALUE: Expression = {
  type: 'Identifier',
  name: 'undefined',
}

/** Rebuild one object-pattern property value list. */
function objectPatternExpression(
  pattern: ObjectPattern,
  rebuild: (pattern: Pattern) => Expression,
): Expression {
  return {
    type: 'ObjectExpression',
    properties: pattern.properties.map((property) => {
      if (property.type === 'RestElement') {
        return { type: 'SpreadElement', argument: rebuild(property.argument) }
      }
      return {
        type: 'Property',
        kind: 'init',
        method: false,
        shorthand: false,
        computed: property.computed,
        key: property.key,
        value: rebuild(property.value),
      }
    }),
  }
}

/** Rebuild one array-pattern element list. */
function arrayPatternExpression(
  pattern: ArrayPattern,
  rebuild: (pattern: Pattern) => Expression,
): Expression {
  return {
    type: 'ArrayExpression',
    elements: pattern.elements.map((element) => {
      if (element === null) {
        return null
      }
      if (element.type === 'RestElement') {
        return { type: 'SpreadElement', argument: rebuild(element.argument) }
      }
      return rebuild(element)
    }),
  }
}

/**
 * Rebuild a pattern as a plain value expression; no spread or hole is produced,
 * and shapes that cannot be a value fall back to an identifier evaluating to
 * `undefined`.
 */
function patternValue(pattern: Pattern): Expression {
  switch (pattern.type) {
    case 'Identifier': {
      return { type: 'Identifier', name: pattern.name }
    }
    case 'AssignmentPattern': {
      return patternValue(pattern.left)
    }
    case 'ObjectPattern': {
      return objectPatternExpression(pattern, patternValue)
    }
    case 'ArrayPattern': {
      return arrayPatternExpression(pattern, patternValue)
    }
    case 'RestElement': {
      return UNSUPPORTED_PATTERN_VALUE
    }
    case 'MemberExpression': {
      return UNSUPPORTED_PATTERN_VALUE
    }
    default: {
      return UNSUPPORTED_PATTERN_VALUE
    }
  }
}
/**
 * Convert a bound parameter pattern into the expression that rebuilds its value
 * for the synthetic arrow argument array. Patterns bind their names before the
 * injected statements run, so identifiers, defaults, rest, and destructuring
 * can be reconstructed. The result is a new partial object/array for
 * destructured parameters; computed destructuring keys are evaluated again
 * during reconstruction.
 */
function patternToExpression(
  pattern: Pattern,
): Expression | SpreadElement | null {
  if (pattern.type === 'RestElement') {
    return { type: 'SpreadElement', argument: patternValue(pattern.argument) }
  }
  if (pattern.type === 'MemberExpression') {
    return null
  }
  return patternValue(pattern)
}

export { isConstructorTarget, matchFunction, patternToExpression }
