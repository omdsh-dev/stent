/**
 * Build the ESTree statements injected into a matched Stent function.
 *
 * The builders keep AST construction separate from matching and orchestration:
 * they create argument capture, replay closure, call record, and
 * generator-aware publish result; generated code assumes unshadowed
 * `arguments`, `Array`, `Symbol`, and `globalThis`.
 *
 * @module @oh-my-dsh/stent/transform/statements
 */

import type {
  CallExpression,
  Expression,
  FunctionExpression,
  Identifier,
  MemberExpression,
  Property,
  Statement,
} from 'estree'

import type { MatchedFunction, NameAllocator } from './ast-types.ts'
import { patternToExpression } from './patterns.ts'
import { GLOBAL_BRIDGE_KEY } from './protocol.ts'

interface CallNames {
  argsName: string
  tracedName: string
  callName: string
}

/** Injected statement list inputs. */
interface InjectedInputs {
  capture: Statement | undefined
  args: Statement
  traced: Statement
  call: Statement
  publish: Statement
}

function member(
  object: Expression,
  property: Expression,
  computed: boolean,
): MemberExpression {
  return {
    type: 'MemberExpression',
    computed,
    optional: false,
    object,
    property,
  }
}

function callExpression(
  callee: Expression,
  args: Expression[],
): CallExpression {
  return { type: 'CallExpression', optional: false, callee, arguments: args }
}

function propertyNode(key: string, value: Expression): Property {
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

function variableDeclaration(name: string, init: Expression): Statement {
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

/** Optional capture of an arrow's enclosing `arguments` object. */
function createOuterArgumentsCapture(
  name: string | undefined,
): Statement | undefined {
  if (name === undefined) {
    return undefined
  }
  return variableDeclaration(name, { type: 'Identifier', name: 'arguments' })
}

function argumentsInit(matched: MatchedFunction): Expression {
  if (matched.arrow) {
    return {
      type: 'ArrayExpression',
      elements: matched.params.map(patternToExpression),
    }
  }
  const arrayPrototype = member(
    { type: 'Identifier', name: 'Array' },
    { type: 'Identifier', name: 'prototype' },
    false,
  )
  const sliceCall = member(
    arrayPrototype,
    { type: 'Identifier', name: 'slice' },
    false,
  )
  const sliceOnArrayPrototype = member(
    sliceCall,
    { type: 'Identifier', name: 'call' },
    false,
  )
  return callExpression(sliceOnArrayPrototype, [
    { type: 'Identifier', name: 'arguments' },
  ])
}
function createArgumentsStatement(
  matched: MatchedFunction,
  name: string,
): Statement {
  return variableDeclaration(name, argumentsInit(matched))
}

/**
 * Anonymous closure replaying the original body with `.apply(this, args)`;
 * ordinary-body `arguments` introspection observes the replay function.
 */
function createTracedStatement(
  matched: MatchedFunction,
  body: Statement[],
  names: Pick<CallNames, 'argsName' | 'tracedName'>,
): Statement {
  const replay: FunctionExpression = {
    type: 'FunctionExpression',
    id: null,
    params: matched.params,
    body: { type: 'BlockStatement', body },
    generator: matched.generator,
    async: matched.async,
  }
  const replayCall = callExpression(
    member(replay, { type: 'Identifier', name: 'apply' }, false),
    [{ type: 'ThisExpression' }, { type: 'Identifier', name: names.argsName }],
  )
  return variableDeclaration(names.tracedName, {
    type: 'ArrowFunctionExpression',
    expression: false,
    generator: false,
    async: false,
    params: [],
    body: {
      type: 'BlockStatement',
      body: [{ type: 'ReturnStatement', argument: replayCall }],
    },
  })
}

/** Bridge call record; `operation` passes through unvalidated. */
function createCallStatement(
  patchId: string,
  operation: string,
  names: CallNames,
): Statement {
  return variableDeclaration(names.callName, {
    type: 'ObjectExpression',
    properties: [
      propertyNode('id', { type: 'Literal', value: patchId }),
      propertyNode('operation', { type: 'Literal', value: operation }),
      propertyNode('arguments', {
        type: 'Identifier',
        name: names.argsName,
      }),
      propertyNode('self', { type: 'ThisExpression' }),
      propertyNode('traced', {
        type: 'Identifier',
        name: names.tracedName,
      }),
    ],
  })
}

function publishExpression(callName: string, tracedName: string): Expression {
  const bridge = member(
    { type: 'Identifier', name: 'globalThis' },
    { type: 'Literal', value: GLOBAL_BRIDGE_KEY },
    true,
  )
  return {
    type: 'ConditionalExpression',
    test: bridge,
    consequent: callExpression(
      member(bridge, { type: 'Identifier', name: 'publish' }, false),
      [{ type: 'Identifier', name: callName }],
    ),
    alternate: callExpression({ type: 'Identifier', name: tracedName }, []),
  }
}

/** Sync or async iteration check for generator delegation. */
function iterableExpression(name: string, async: boolean): Expression {
  const check = (symbol: 'iterator' | 'asyncIterator'): Expression => ({
    type: 'BinaryExpression',
    operator: '===',
    left: {
      type: 'UnaryExpression',
      operator: 'typeof',
      prefix: true,
      argument: member(
        { type: 'Identifier', name },
        member(
          { type: 'Identifier', name: 'Symbol' },
          { type: 'Identifier', name: symbol },
          false,
        ),
        true,
      ),
    },
    right: { type: 'Literal', value: 'function' },
  })
  if (async) {
    return {
      type: 'LogicalExpression',
      operator: '||',
      left: check('iterator'),
      right: check('asyncIterator'),
    }
  }
  return check('iterator')
}

/** Generator delegation: `yield*` iterable results, otherwise return them. */
function delegationStatement(resultName: string, async: boolean): Statement {
  const result: Identifier = { type: 'Identifier', name: resultName }
  const yieldResult: Expression = {
    type: 'YieldExpression',
    delegate: true,
    argument: result,
  }
  return {
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
      right: iterableExpression(resultName, async),
    },
    consequent: { type: 'ReturnStatement', argument: yieldResult },
  }
}

/** Publish/fallback code; generators delegate iterable results. */
function createPublishStatement(
  matched: MatchedFunction,
  allocator: NameAllocator,
  names: Pick<CallNames, 'callName' | 'tracedName'>,
): Statement {
  const { callName, tracedName } = names
  if (!matched.generator) {
    return {
      type: 'ReturnStatement',
      argument: publishExpression(callName, tracedName),
    }
  }
  const resultName = allocator.unique('stentResult')
  const result: Identifier = { type: 'Identifier', name: resultName }
  const delegate = delegationStatement(resultName, matched.async)
  const publish: Statement = {
    type: 'BlockStatement',
    body: [
      variableDeclaration(resultName, publishExpression(callName, tracedName)),
      delegate,
      { type: 'ReturnStatement', argument: result },
    ],
  }
  return publish
}
function createInjectedStatements(injected: InjectedInputs): Statement[] {
  const { capture, args, traced, call, publish } = injected
  return [capture, args, traced, call, publish].filter(
    (statement): statement is Statement => statement !== undefined,
  )
}

export {
  createOuterArgumentsCapture,
  createArgumentsStatement,
  createTracedStatement,
  createCallStatement,
  createPublishStatement,
  createInjectedStatements,
}
