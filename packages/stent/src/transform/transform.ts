/**
 * Orchestrion custom transform for Stent. Instead of the built-in tracing
 * transform (which always runs the original body inside its traced closure,
 * making `around`/`replace` vetoes impossible), this transform rewrites the
 * matched function to call the Stent bridge directly.
 *
 * The function keeps its name, `.length`, and `this` binding. The original body
 * moves into a `traced` closure that replays it via `apply(this, args)` over
 * the reconstructed arguments array, and the body becomes a single conditional
 * return: `globalThis[<bridge key>]` present → publish the call, absent →
 * delegate to the traced body untouched. The bridge-absent fallback makes
 * transformed code safe before the bootstrap runs (and in browsers before the
 * bridge is installed), at the cost of the patch only taking effect for calls
 * that happen after the bridge exists.
 *
 * Matched nodes must be function declarations, function expressions, methods,
 * or arrow functions with a block (or, for arrows, expression) body. Arrows
 * have no own `arguments` binding, so the argument array is rebuilt from the
 * parameter patterns (identifiers, rest, defaults, and destructuring all work —
 * the patterns bind their names before the injected statements run) and `this`
 * stays lexical; a body referencing the enclosing `arguments` object is
 * preserved by capturing it first. Generator functions transform through
 * delegation (`yield*` over the traced generator), so iteration semantics
 * survive the no-handler and delegated paths.
 *
 * @module @oh-my-dsh/stent/transform/transform
 */

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

import type { CustomTransform, InstrumentationMatcher } from './orchestrion.ts'
import { GLOBAL_BRIDGE_KEY } from './protocol.ts'

/** Identifier prefixes injected by this transform. */
const ARGS = 'stentArguments'
const TRACED = 'stentTraced'
const CALL = 'stentCall'
const OUTER_ARGUMENTS = 'stentOuterArguments'

/**
 * Register the Stent custom transform on an Orchestrion matcher. Both the Node
 * loader and the browser build register the same operator, which reads the
 * patch id and operation from the merged state.
 *
 * @param matcher - The Orchestrion matcher to extend.
 * @param onMatch - Optional callback invoked with the patch id for every node
 *   the transform actually rewrites; the Node loader counts these into its
 *   load-time binding records.
 */
export function registerStentTransform(
  matcher: InstrumentationMatcher,
  onMatch?: (patchId: string) => void,
): void {
  matcher.addTransform('stent', (state, node, parent, ancestry) => {
    const patchId = state.stentPatchId
    const operation = state.stentOperation
    if (typeof patchId !== 'string' || typeof operation !== 'string') {
      throw new Error(
        'stent: transform config must carry stentPatchId and stentOperation strings',
      )
    }
    if (
      createStentTransform(patchId, operation)(state, node, parent, ancestry)
    ) {
      onMatch?.(patchId)
    }
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
 *
 * @param patchId - The patch id stamped into the generated call.
 * @param operation - The operation kind stamped into the generated call.
 * @returns The per-node rewrite function, returning whether the node was
 *   actually rewritten (false for selected non-function nodes).
 */
function createStentTransform(
  patchId: string,
  operation: string,
): (
  state: Parameters<CustomTransform>[0],
  node: Node,
  parent: Node,
  ancestry: Node[],
) => boolean {
  return (_state, node, parent, ancestry) =>
    transformMatchedNode(patchId, operation, node, parent, ancestry)
}

function transformMatchedNode(
  patchId: string,
  operation: string,
  node: Node,
  parent: Node,
  ancestry: Node[],
): boolean {
  return transformMatchedFunction(patchId, operation, node, parent, ancestry)
}

function transformMatchedFunction(
  patchId: string,
  operation: string,
  node: Node,
  parent: Node,
  ancestry: Node[],
): boolean {
  if (isConstructorTarget(node, parent)) {
    throw new Error(
      'stent: constructor targets are not supported (super() and new.target cannot survive '
        + 'the traced-closure replay); patch a method or factory instead',
    )
  }
  const matched = matchFunction(node)
  const program = ancestry[ancestry.length - 1]
  if (!matched || !program || program.type !== 'Program' || !matched.body) {
    return false
  }
  const block = ensureBlockBody(matched)
  const names = namesOf(program)
  const outerArgsName = prepareOuterArguments(matched, block, names)
  const argsName = names.unique(ARGS)
  const tracedName = names.unique(TRACED)
  const callName = names.unique(CALL)
  const capture = createOuterArgumentsCapture(outerArgsName)
  const args = createArgumentsStatement(matched, argsName)
  const traced = createTracedStatement(
    matched,
    block.body,
    argsName,
    tracedName,
  )
  const call = createCallStatement(
    patchId,
    operation,
    argsName,
    tracedName,
    callName,
  )
  const publish = createPublishStatement(matched, names, callName, tracedName)
  block.body = createInjectedStatements(capture, args, traced, call, publish)
  return true
}

function ensureBlockBody(matched: MatchedFunction): {
  type: 'BlockStatement'
  body: Statement[]
} {
  if (matched.body?.type !== 'BlockStatement') {
    const synthesized: Node = {
      type: 'BlockStatement',
      body: [{ type: 'ReturnStatement', argument: matched.body as Expression }],
    }
    matched.node.body = synthesized
    matched.body = synthesized
  }
  return matched.body
}

function prepareOuterArguments(
  matched: MatchedFunction,
  block: { body: Statement[] },
  names: ReturnType<typeof namesOf>,
): string | undefined {
  if (
    !matched.arrow
    || !mapOuterArguments(block as unknown as Node, undefined)
  ) {
    return undefined
  }
  const name = names.unique(OUTER_ARGUMENTS)
  mapOuterArguments(block as unknown as Node, name)
  return name
}

function createOuterArgumentsCapture(
  name: string | undefined,
): Statement | undefined {
  if (name === undefined) {
    return undefined
  }
  return {
    type: 'VariableDeclaration',
    kind: 'const',
    declarations: [
      {
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name },
        init: { type: 'Identifier', name: 'arguments' },
      },
    ],
  }
}

function createArgumentsStatement(
  matched: MatchedFunction,
  name: string,
): Statement {
  const init: Expression = matched.arrow
    ? {
        type: 'ArrayExpression',
        elements: matched.params.map(patternToExpression),
      }
    : {
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
      }
  return {
    type: 'VariableDeclaration',
    kind: 'const',
    declarations: [
      {
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name },
        init,
      },
    ],
  }
}

function createTracedStatement(
  matched: MatchedFunction,
  body: Statement[],
  argsName: string,
  tracedName: string,
): Statement {
  return {
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
                      body: { type: 'BlockStatement', body },
                      generator: matched.generator,
                      async: matched.async,
                    },
                    property: { type: 'Identifier', name: 'apply' },
                  },
                  arguments: [
                    { type: 'ThisExpression' },
                    { type: 'Identifier', name: argsName },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  }
}

function createCallStatement(
  patchId: string,
  operation: string,
  argsName: string,
  tracedName: string,
  callName: string,
): Statement {
  return {
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
}

function bridgeExpression(): Expression {
  return {
    type: 'MemberExpression',
    computed: true,
    optional: false,
    object: { type: 'Identifier', name: 'globalThis' },
    property: { type: 'Literal', value: GLOBAL_BRIDGE_KEY },
  }
}

function publishExpression(callName: string, tracedName: string): Expression {
  const bridge = bridgeExpression()
  return {
    type: 'ConditionalExpression',
    test: bridge,
    consequent: {
      type: 'CallExpression',
      optional: false,
      callee: {
        type: 'MemberExpression',
        computed: false,
        optional: false,
        object: bridge,
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
  }
}

function createPublishStatement(
  matched: MatchedFunction,
  names: ReturnType<typeof namesOf>,
  callName: string,
  tracedName: string,
): Statement {
  if (!matched.generator) {
    return {
      type: 'ReturnStatement',
      argument: publishExpression(callName, tracedName),
    }
  }
  const resultName = names.unique('stentResult')
  const result = { type: 'Identifier' as const, name: resultName }
  const delegate: Statement = {
    type: 'IfStatement',
    test: {
      type: 'LogicalExpression',
      operator: '&&',
      left: {
        type: 'BinaryExpression',
        operator: '!=',
        left: result,
        right: { type: 'Literal', value: null },
      },
      right: iterableExpression(resultName, matched.async),
    },
    consequent: {
      type: 'ReturnStatement',
      argument: { type: 'YieldExpression', delegate: true, argument: result },
    },
  }
  return {
    type: 'BlockStatement',
    body: [
      {
        type: 'VariableDeclaration',
        kind: 'const',
        declarations: [
          {
            type: 'VariableDeclarator',
            id: result,
            init: publishExpression(callName, tracedName),
          },
        ],
      },
      delegate,
      { type: 'ReturnStatement', argument: result },
    ],
  } as unknown as Statement
}

function iterableExpression(name: string, async: boolean): Expression {
  const check = (symbol: 'iterator' | 'asyncIterator'): Expression => ({
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
        object: { type: 'Identifier', name },
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
  return async
    ? {
        type: 'LogicalExpression',
        operator: '||',
        left: check('iterator'),
        right: check('asyncIterator'),
      }
    : check('iterator')
}

function createInjectedStatements(
  capture: Statement | undefined,
  args: Statement,
  traced: Statement,
  call: Statement,
  publish: Statement,
): Statement[] {
  const injected = [capture, args, traced, call, publish]
  return injected.filter(
    (statement): statement is Statement => statement !== undefined,
  )
}

/** Whether the matched node selects a class constructor. */
function isConstructorTarget(node: Node, parent: Node): boolean {
  const nodeKind =
    node.type === 'MethodDefinition'
      ? (node as { kind?: unknown }).kind
      : undefined
  const parentKind =
    parent.type === 'MethodDefinition'
      ? (parent as { kind?: unknown }).kind
      : undefined
  return nodeKind === 'constructor' || parentKind === 'constructor'
}

/**
 * Extract a transformable function from the matched node. Class methods and
 * object properties are wrapped; the actual function lives in their `value`.
 *
 * @param node - The matched AST node.
 * @returns The function with its body and params, or `undefined` to skip.
 */
function matchFunction(node: Node): MatchedFunction | undefined {
  const fn =
    node.type === 'MethodDefinition' || node.type === 'Property'
      ? (node as { value?: unknown }).value
      : node
  if (typeof fn !== 'object' || fn === null) {
    return undefined
  }
  const type = (fn as { type?: string }).type
  if (
    type !== 'FunctionDeclaration'
    && type !== 'FunctionExpression'
    && type !== 'ArrowFunctionExpression'
  ) {
    return undefined
  }
  const functionNode = fn as
    | FunctionDeclaration
    | FunctionExpression
    | ArrowFunctionExpression
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
    body: (functionNode as { body?: unknown }).body as Node | undefined,
    params: functionNode.params,
    async: functionNode.async ?? false,
    generator: functionNode.generator ?? false,
  }
}

/**
 * Convert a bound parameter pattern into the expression that rebuilds its value
 * for the reconstructed arrow argument array. Patterns bind their names before
 * the injected statements run (defaults are evaluated during binding), so every
 * shape is representable as an expression over the bound names: an identifier
 * is a reference, object/array patterns become their literal shape over the
 * bound names, an assignment pattern is its bound pattern, and a rest element
 * becomes a spread (the array element position only).
 *
 * @param pattern - A parameter pattern.
 * @returns The array element expression (spread for rest), or null for a
 *   pattern shape the transform does not convert (never a parameter list).
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
 *
 * @param node - The node to scan (and rewrite when `name` is given).
 * @param name - Capture name to rewrite `arguments` references to; omit to only
 *   detect references.
 * @returns True when at least one outer `arguments` reference was found.
 */
function mapOuterArguments(
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
    return value.some(
      (child) =>
        typeof child === 'object'
        && child !== null
        && mapOuterArguments(child as Node, name),
    )
  }
  if (typeof value === 'object' && value !== null) {
    return mapOuterArguments(value as Node, name)
  }
  return false
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
 * seeded with every identifier of the program on first use, so an injected name
 * can never shadow a reference the traced body keeps resolving.
 *
 * @param program - The matched file's Program node.
 * @returns A `unique(base)` allocator for that file.
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
