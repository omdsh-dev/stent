/**
 * Orchestrion custom transform for Stent. Instead of the built-in tracing
 * transform (which always runs the original body inside its traced closure,
 * making `around`/`replace` vetoes impossible), this transform rewrites the
 * matched function to call the Stent bridge directly.
 *
 * The function keeps its name, `.length`, and `this` binding. The original
 * body moves into a `traced` closure that replays it via `apply(this, args)`
 * over the reconstructed arguments array, and the body becomes a single
 * conditional return: `globalThis[<bridge key>]` present → publish the call,
 * absent → delegate to the traced body untouched. The bridge-absent fallback
 * makes transformed code safe before the bootstrap runs (and in browsers
 * before the bridge is installed), at the cost of the patch only taking
 * effect for calls that happen after the bridge exists.
 *
 * Matched nodes must be function declarations, function expressions, methods,
 * or arrow functions with a block (or, for arrows, expression) body. Arrows
 * have no own `arguments` binding, so the argument array is rebuilt from the
 * parameter patterns (identifiers, rest, defaults, and destructuring all
 * work — the patterns bind their names before the injected statements run)
 * and `this` stays lexical; a body referencing the enclosing `arguments`
 * object is preserved by capturing it first. Generator functions transform
 * through delegation (`yield*` over the traced generator), so iteration
 * semantics survive the no-handler and delegated paths.
 * @module @oh-my-dsh/stent/transform/transform
 */

import type { CustomTransform, InstrumentationMatcher } from './orchestrion.ts'
import type {
  ArrowFunctionExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  Literal,
  Node,
  Pattern,
  Program,
  Property,
  SpreadElement,
  Statement,
} from 'estree'
import { GLOBAL_BRIDGE_KEY } from './protocol.ts'

/** Identifier prefixes injected by this transform. */
const ARGS = 'stentArguments'
const TRACED = 'stentTraced'
const CALL = 'stentCall'
const OUTER_ARGUMENTS = 'stentOuterArguments'

/**
 * Register the Stent custom transform on an Orchestrion matcher. Both the
 * Node loader and the browser build register the same operator, which reads
 * the patch id and operation from the merged state.
 * @param matcher - the Orchestrion matcher to extend.
 * @param onMatch - optional callback invoked with the patch id for every
 * node the transform actually rewrites; the Node loader counts these into
 * its load-time binding records.
 */
export function registerStentTransform(matcher: InstrumentationMatcher, onMatch?: (patchId: string) => void): void {
  matcher.addTransform('stent', (state, node, parent, ancestry) => {
    const patchId = state.stentPatchId
    const operation = state.stentOperation
    if (typeof patchId !== 'string' || typeof operation !== 'string') {
      throw new Error('stent: transform config must carry stentPatchId and stentOperation strings')
    }
    if (createStentTransform(patchId, operation)(state, node, parent, ancestry)) onMatch?.(patchId)
  })
}

/** One matched function with its parameter list. */
interface MatchedFunction {
  /** The function-like node (MethodDefinition/Property unwrapped). */
  node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression
  /** Whether the node is an arrow function (lexical `this`/`arguments`). */
  arrow: boolean
  /** The function body (block, or an expression for expression-bodied arrows). */
  body: Node | undefined
  /** The parameter list. */
  params: Pattern[]
  /** Whether the node is an async function (its body may await). */
  async: boolean
  /** Whether the node is a generator function (its body may yield). */
  generator: boolean
}

/**
 * Build the Stent custom transform for a patch.
 * @param patchId - the patch id stamped into the generated call.
 * @param operation - the operation kind stamped into the generated call.
 * @returns the per-node rewrite function, returning whether the node was
 * actually rewritten (false for selected non-function nodes).
 */
function createStentTransform(
  patchId: string,
  operation: string,
): (state: Parameters<CustomTransform>[0], node: Node, parent: Node, ancestry: Node[]) => boolean {
  return (_state, node, parent, ancestry) => {
    if (isConstructorTarget(node, parent)) {
      // A constructor body cannot move into the traced closure: a derived
      // constructor's super() call is a syntax error inside a plain function,
      // and new.target would silently become undefined. Fail the transform
      // loudly instead of emitting a module that breaks at evaluation.
      throw new Error(
        'stent: constructor targets are not supported (super() and new.target cannot survive ' +
          'the traced-closure replay); patch a method or factory instead',
      )
    }
    const matched = matchFunction(node)
    if (!matched) return false
    const program = ancestry[ancestry.length - 1]
    if (!program || program.type !== 'Program') return false

    // Expression-bodied arrows get a synthesized block body so the injected
    // statements have a statement list to live in. Both the node and the
    // local `body` reference must move to the new block.
    if (!matched.body) return false
    if (matched.body.type !== 'BlockStatement') {
      const statements: Statement[] = [{ type: 'ReturnStatement', argument: matched.body as Expression }]
      const synthesized: Node = { type: 'BlockStatement', body: statements }
      matched.node.body = synthesized
      matched.body = synthesized
    }
    const block = matched.body as { type: 'BlockStatement'; body: Statement[] }
    const statements = block.body

    // Injected names must not shadow identifiers the file already uses (the
    // traced body keeps resolving through the transformed function's scope);
    // the per-program allocator is seeded with every identifier in the file.
    const refs = namesOf(program)
    const argsName = refs.unique(ARGS)
    const tracedName = refs.unique(TRACED)
    const callName = refs.unique(CALL)

    // An arrow body referencing the enclosing `arguments` object would break
    // when moved into the traced regular function (its own `arguments` would
    // shadow the outer one). The arrow's own lexical resolution makes
    // `arguments` in an injected capture statement refer to the outer scope,
    // so the reference is preserved: capture it first, then rewrite the
    // body's `arguments` identifiers (lexical references only — nested
    // non-arrow functions own their `arguments` and are not descended into)
    // to the capture.
    const outerArgsName =
      matched.arrow && mapOuterArguments(matched.body, undefined) ? refs.unique(OUTER_ARGUMENTS) : undefined
    if (outerArgsName) mapOuterArguments(matched.body, outerArgsName)

    // const stentOuterArguments = arguments
    // Only arrows: the arrow's own lexical resolution makes `arguments` here
    // refer to the enclosing scope, preserving the body's outer reference.
    const capture: Statement | undefined =
      outerArgsName === undefined
        ? undefined
        : {
            type: 'VariableDeclaration',
            kind: 'const',
            declarations: [
              {
                type: 'VariableDeclarator',
                id: { type: 'Identifier', name: outerArgsName },
                init: { type: 'Identifier', name: 'arguments' },
              },
            ],
          }

    // const stentArguments = <args>
    // Regular functions rebuild from their own `arguments` object; arrows have
    // no own binding, so the array is assembled from the parameter patterns —
    // handler mutations then flow through apply() to the replayed body.
    const args: Statement = matched.arrow
      ? {
          type: 'VariableDeclaration',
          kind: 'const',
          declarations: [
            {
              type: 'VariableDeclarator',
              id: { type: 'Identifier', name: argsName },
              init: {
                type: 'ArrayExpression',
                elements: matched.params.map(patternToExpression),
              },
            },
          ],
        }
      : {
          type: 'VariableDeclaration',
          kind: 'const',
          declarations: [
            {
              type: 'VariableDeclarator',
              id: { type: 'Identifier', name: argsName },
              init: {
                type: 'CallExpression',
                optional: false,
                callee: {
                  type: 'MemberExpression',
                  computed: false,
                  optional: false,
                  object: {
                    type: 'MemberExpression',
                    computed: false,
                    optional: false,
                    object: {
                      type: 'MemberExpression',
                      computed: false,
                      optional: false,
                      object: { type: 'Identifier', name: 'Array' },
                      property: { type: 'Identifier', name: 'prototype' },
                    },
                    property: { type: 'Identifier', name: 'slice' },
                  },
                  property: { type: 'Identifier', name: 'call' },
                },
                arguments: [{ type: 'Identifier', name: 'arguments' }],
              },
            },
          ],
        }

    // const stentTraced = () => (function () { <original body> }).apply(this, stentArguments)
    const traced: Statement = {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: { type: 'Identifier', name: tracedName },
          init: {
            type: 'ArrowFunctionExpression',
            expression: false,
            generator: false,
            async: false,
            params: [],
            body: {
              type: 'BlockStatement',
              body: [
                {
                  type: 'ReturnStatement',
                  argument: {
                    type: 'CallExpression',
                    optional: false,
                    callee: {
                      type: 'MemberExpression',
                      computed: false,
                      optional: false,
                      object: {
                        type: 'FunctionExpression',
                        id: null,
                        params: matched.params,
                        body: { type: 'BlockStatement', body: statements },
                        generator: matched.generator,
                        async: matched.async,
                      },
                      property: { type: 'Identifier', name: 'apply' },
                    },
                    arguments: [{ type: 'ThisExpression' }, { type: 'Identifier', name: argsName }],
                  },
                },
              ],
            },
          },
        },
      ],
    }

    // const stentCall = { id, operation, arguments: stentArguments, self, traced }
    const call: Statement = {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: { type: 'Identifier', name: callName },
          init: {
            type: 'ObjectExpression',
            properties: [
              property('id', { type: 'Literal', value: patchId }),
              property('operation', { type: 'Literal', value: operation }),
              property('arguments', { type: 'Identifier', name: argsName }),
              property('self', { type: 'ThisExpression' }),
              property('traced', { type: 'Identifier', name: tracedName }),
            ],
          },
        },
      ],
    }

    // globalThis["__stentBridge"]
    const bridge = (): Expression => ({
      type: 'MemberExpression',
      computed: true,
      optional: false,
      object: { type: 'Identifier', name: 'globalThis' },
      property: { type: 'Literal', value: GLOBAL_BRIDGE_KEY },
    })

    // globalThis["__stentBridge"] ? publish(stentCall) : stentTraced()
    const publishCall = (): Expression => ({
      type: 'ConditionalExpression',
      test: bridge(),
      consequent: {
        type: 'CallExpression',
        optional: false,
        callee: {
          type: 'MemberExpression',
          computed: false,
          optional: false,
          object: bridge(),
          property: { type: 'Identifier', name: 'publish' },
        },
        arguments: [{ type: 'Identifier', name: callName }],
      },
      alternate: {
        type: 'CallExpression',
        optional: false,
        callee: { type: 'Identifier', name: tracedName },
        arguments: [],
      },
    })

    // Generator functions delegate instead of returning: publish may hand
    // back the traced generator (no handler, before, or an around/replace
    // that invoked), which is delegated with `yield*` so iteration semantics
    // survive; a handler-supplied replacement that is not iterable is
    // returned directly (the caller's choice to break the iterator contract).
    // Async generators also accept async iterables.
    let publish: Statement
    if (matched.generator) {
      const resultName = refs.unique('stentResult')
      const isIterable = (symbol: 'iterator' | 'asyncIterator'): Expression => ({
        type: 'BinaryExpression',
        operator: '===',
        left: {
          type: 'UnaryExpression',
          operator: 'typeof',
          prefix: true,
          argument: {
            type: 'MemberExpression',
            computed: true,
            optional: false,
            object: { type: 'Identifier', name: resultName },
            property: {
              type: 'MemberExpression',
              computed: false,
              optional: false,
              object: { type: 'Identifier', name: 'Symbol' },
              property: { type: 'Identifier', name: symbol },
            },
          },
        },
        right: { type: 'Literal', value: 'function' },
      })
      const iterableCheck: Expression = matched.async
        ? {
            type: 'LogicalExpression',
            operator: '||',
            left: isIterable('iterator'),
            right: isIterable('asyncIterator'),
          }
        : isIterable('iterator')
      publish = {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: { type: 'Identifier', name: resultName },
            init: publishCall(),
          },
        ],
      }
      const delegate: Statement = {
        type: 'IfStatement',
        test: {
          type: 'LogicalExpression',
          operator: '&&',
          left: {
            type: 'BinaryExpression',
            operator: '!=',
            left: { type: 'Identifier', name: resultName },
            right: { type: 'Literal', value: null },
          },
          right: iterableCheck,
        },
        consequent: {
          type: 'ReturnStatement',
          argument: {
            type: 'YieldExpression',
            delegate: true,
            argument: { type: 'Identifier', name: resultName },
          },
        },
      }
      const fallbackReturn: Statement = {
        type: 'ReturnStatement',
        argument: { type: 'Identifier', name: resultName },
      }
      const delegatedBody: (Statement | undefined)[] = [capture, args, traced, call, publish, delegate, fallbackReturn]
      block.body = delegatedBody.filter((statement): statement is Statement => statement !== undefined)
      return true
    }

    publish = {
      type: 'ReturnStatement',
      argument: publishCall(),
    }

    const injected: (Statement | undefined)[] = [capture, args, traced, call, publish]
    block.body = injected.filter((statement): statement is Statement => statement !== undefined)
    return true
  }
}

/** Whether the matched node selects a class constructor. */
function isConstructorTarget(node: Node, parent: Node): boolean {
  const nodeKind = node.type === 'MethodDefinition' ? (node as { kind?: unknown }).kind : undefined
  const parentKind = parent.type === 'MethodDefinition' ? (parent as { kind?: unknown }).kind : undefined
  return nodeKind === 'constructor' || parentKind === 'constructor'
}

/**
 * Extract a transformable function from the matched node. Class methods and
 * object properties are wrapped; the actual function lives in their `value`.
 * @param node - the matched AST node.
 * @returns the function with its body and params, or `undefined` to skip.
 */
function matchFunction(node: Node): MatchedFunction | undefined {
  const fn = node.type === 'MethodDefinition' || node.type === 'Property' ? (node as { value?: unknown }).value : node
  if (typeof fn !== 'object' || fn === null) return undefined
  const type = (fn as { type?: string }).type
  if (type !== 'FunctionDeclaration' && type !== 'FunctionExpression' && type !== 'ArrowFunctionExpression') {
    return undefined
  }
  const functionNode = fn as FunctionDeclaration | FunctionExpression | ArrowFunctionExpression
  const arrow = type === 'ArrowFunctionExpression'
  if (arrow) {
    // A parameter literally named `arguments` would shadow the outer
    // `arguments` object the body may reference; skip rather than guess which
    // one the body means. All other pattern shapes (rest, defaults,
    // destructuring) are supported.
    if (functionNode.params.some(param => patternNames(param).has('arguments'))) return undefined
  }
  return {
    node: functionNode,
    arrow,
    body: (functionNode as { body?: unknown }).body as Node | undefined,
    params: functionNode.params,
    async: functionNode.async ?? false,
    generator: functionNode.generator ?? false,
  }
}

/**
 * Convert a bound parameter pattern into the expression that rebuilds its
 * value for the reconstructed arrow argument array. Patterns bind their names
 * before the injected statements run (defaults are evaluated during
 * binding), so every shape is representable as an expression over the bound
 * names: an identifier is a reference, object/array patterns become their
 * literal shape over the bound names, an assignment pattern is its bound
 * pattern, and a rest element becomes a spread (the array element position
 * only).
 * @param pattern - a parameter pattern.
 * @returns the array element expression (spread for rest), or null for a
 * pattern shape the transform does not convert (never a parameter list).
 */
function patternToExpression(pattern: Pattern): Expression | SpreadElement | null {
  switch (pattern.type) {
    case 'Identifier':
      return { type: 'Identifier', name: pattern.name }
    case 'AssignmentPattern':
      return patternToExpression(pattern.left)
    case 'RestElement':
      return { type: 'SpreadElement', argument: patternToExpression(pattern.argument) as Expression }
    case 'ObjectPattern':
      return {
        type: 'ObjectExpression',
        properties: pattern.properties.map(prop => {
          if (prop.type === 'RestElement') {
            return { type: 'SpreadElement', argument: patternToExpression(prop.argument) as Expression }
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
        elements: pattern.elements.map(element => {
          if (element === null) return null
          if (element.type === 'RestElement') {
            return { type: 'SpreadElement', argument: patternToExpression(element.argument) as Expression }
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
 * @param pattern - a parameter pattern.
 * @returns the set of bound names.
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
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, out)
        else collectPatternNames(prop.value, out)
      }
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) {
        if (element !== null) collectPatternNames(element, out)
      }
      break
    default:
      // No other Pattern shape binds names (defensive: never a parameter list).
      break
  }
}

/**
 * Whether a node references the enclosing scope's `arguments` object, and
 * optionally rewrites those references to a capture name. Nested non-arrow
 * functions own their `arguments` and are not descended into; nested arrows
 * still resolve lexically and are descended into. Property keys and
 * non-computed member properties are not references.
 * @param node - the node to scan (and rewrite when `name` is given).
 * @param name - capture name to rewrite `arguments` references to; omit to
 * only detect references.
 * @returns true when at least one outer `arguments` reference was found.
 */
function mapOuterArguments(node: Node | undefined, name: string | undefined): boolean {
  if (!node) return false
  if (node.type === 'Identifier') {
    if (node.name !== 'arguments') return false
    if (name !== undefined) node.name = name
    return true
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') return false
  let found = false
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
    // Property keys and non-computed member properties are not references.
    if (key === 'key' && (node.type === 'Property' || node.type === 'MethodDefinition')) continue
    if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === 'object' && child !== null && mapOuterArguments(child as Node, name)) found = true
      }
    } else if (typeof value === 'object' && value !== null) {
      if (mapOuterArguments(value as Node, name)) found = true
    }
  }
  return found
}

/** A `key: value` object property. */
function property(key: string, value: Expression): Property {
  return {
    type: 'Property',
    kind: 'init',
    method: false,
    shorthand: false,
    computed: false,
    key: { type: 'Identifier', name: key },
    value,
  }
}

/**
 * Per-program identifier allocator: injected names are unique within one
 * transformed file and reused deterministically across files. The name set is
 * seeded with every identifier of the program on first use, so an injected
 * name can never shadow a reference the traced body keeps resolving.
 * @param program - the matched file's Program node.
 * @returns a `unique(base)` allocator for that file.
 */
function namesOf(program: Program) {
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
      while (names.has(name)) name = `${base}_${++i}`
      names.add(name)
      return name
    },
  }
}

/**
 * Collect every identifier name in a node into the given set. The walk is
 * deliberately broad (property keys, labels, and member properties included):
 * over-conservative renaming is safe, while a missed variable reference
 * would silently change what the moved body resolves.
 * @param node - the AST node to walk.
 * @param out - the set receiving identifier names.
 */
function collectIdentifiers(node: Node, out: Set<string>): void {
  if (node.type === 'Identifier') {
    out.add(node.name)
    return
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
    const value = (node as unknown as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === 'object' && child !== null) collectIdentifiers(child as Node, out)
      }
    } else if (typeof value === 'object' && value !== null) {
      collectIdentifiers(value as Node, out)
    }
  }
}

/** Per-file injected-name sets, keyed by the transformed Program node. */
const programNames = new WeakMap<Program, Set<string>>()
