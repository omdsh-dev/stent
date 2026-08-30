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
  Expression,
  Identifier,
  Literal,
  Node,
  Pattern,
  SpreadElement,
} from 'estree'

import type { MatchedFunction } from './ast-types.ts'

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

/**
 * Extract a transformable function from the matched node. Class methods and
 * object properties are unwrapped to their `value`. Unsupported nodes return
 * `undefined`; an arrow whose parameter pattern binds `arguments` also returns
 * `undefined` so the transform does not guess which binding its body means.
 * Constructor detection is separate and is not performed by this helper.
 *
 * @param node - The matched AST node.
 * @returns The function with its body and params, or `undefined` to skip.
 */
function matchFunction(node: Node): MatchedFunction | undefined {
  let fn: Node = node
  if (node.type === 'MethodDefinition' || node.type === 'Property') {
    fn = node.value
  }
  const type = fn.type
  if (
    type !== 'FunctionDeclaration'
    && type !== 'FunctionExpression'
    && type !== 'ArrowFunctionExpression'
  ) {
    return undefined
  }
  const functionNode = fn
  const arrow = type === 'ArrowFunctionExpression'
  if (arrow) {
    // A parameter literally named `arguments` would shadow the outer
    // `arguments` object the body may reference; skip rather than guess which
    // one the body means. All other pattern shapes (rest, defaults,
    // destructuring) are supported.
    if (
      functionNode.params.some((param) => patternNames(param).has('arguments'))
    ) {
      return undefined
    }
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

/**
 * Convert a bound parameter pattern into the expression that rebuilds its value
 * for the synthetic arrow argument array. Patterns bind their names before the
 * injected statements run, so identifiers, defaults, rest, and destructuring
 * can be reconstructed. The result is a new partial object/array for
 * destructured parameters; computed destructuring keys are evaluated again
 * during reconstruction.
 *
 * @param pattern - A parameter pattern.
 * @returns The array element expression (spread for rest), or null for a
 *   pattern shape the transform does not convert.
 */
function patternToExpression(
  pattern: Pattern,
): Expression | SpreadElement | null {
  switch (pattern.type) {
    case 'Identifier':
      return { type: 'Identifier', name: pattern.name }
    case 'AssignmentPattern':
      return patternToExpression(pattern.left)
    case 'RestElement':
      return {
        type: 'SpreadElement',
        argument: patternToExpression(pattern.argument) as Expression,
      }
    case 'ObjectPattern':
      return {
        type: 'ObjectExpression',
        properties: pattern.properties.map((prop) => {
          if (prop.type === 'RestElement') {
            return {
              type: 'SpreadElement',
              argument: patternToExpression(prop.argument) as Expression,
            }
          }
          return {
            type: 'Property',
            kind: 'init',
            method: false,
            shorthand: false,
            computed: prop.computed,
            key: prop.key as Identifier | Literal,
            value: patternToExpression(prop.value) as Expression,
          }
        }),
      }
    case 'ArrayPattern':
      return {
        type: 'ArrayExpression',
        elements: pattern.elements.map((element) => {
          if (element === null) {
            return null
          }
          if (element.type === 'RestElement') {
            return {
              type: 'SpreadElement',
              argument: patternToExpression(element.argument) as Expression,
            }
          }
          return patternToExpression(element)
        }),
      }
    default:
      return null
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

/** Recursive helper for {@link patternNames}. */
function collectPatternNames(pattern: Pattern, out: Set<string>): void {
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name)
      break
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out)
      break
    case 'RestElement':
      collectPatternNames(pattern.argument, out)
      break
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') {
          collectPatternNames(prop.argument, out)
        } else {
          collectPatternNames(prop.value, out)
        }
      }
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) {
        if (element !== null) {
          collectPatternNames(element, out)
        }
      }
      break
    default:
      // Other ESTree Pattern variants do not bind parameter names here.
      break
  }
}

export { isConstructorTarget, matchFunction, patternToExpression }
