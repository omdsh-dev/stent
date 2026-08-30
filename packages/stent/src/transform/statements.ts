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

import type { Expression, Property, Statement } from 'estree'

import type { MatchedFunction, NameAllocator } from './ast-types.ts'
import { patternToExpression } from './patterns.ts'
import { GLOBAL_BRIDGE_KEY } from './protocol.ts'

/**
 * Build an optional capture of an arrow's enclosing `arguments` object.
 *
 * @param name - Capture binding; `undefined` produces no statement.
 * @returns A declaration, or `undefined` when no capture is needed.
 */
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

/**
 * Build the ordinary-function slice (requiring unshadowed `arguments`) or arrow
 * pattern array.
 */
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

/**
 * Build an anonymous function closure that replays the original body with
 * `.apply(this, args)`. Ordinary-body `arguments` introspection consequently
 * observes the replay function, not the outer function.
 */
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

/** Build the bridge call record; `operation` passes through unvalidated. */
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

/** Build the global bridge member expression used by generated code. */
function bridgeExpression(): Expression {
  return {
    type: 'MemberExpression',
    computed: true,
    optional: false,
    object: { type: 'Identifier', name: 'globalThis' },
    property: { type: 'Literal', value: GLOBAL_BRIDGE_KEY },
  }
}

/** Build the bridge-present/fallback conditional expression. */
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

/** Build publish/fallback code; generators delegate iterable results. */
function createPublishStatement(
  matched: MatchedFunction,
  names: NameAllocator,
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

/** Detect sync or async iteration for generator delegation. */
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

/**
 * Assemble capture, arguments, replay, call, and publish statements in order.
 *
 * @param capture - Optional outer-arguments declaration.
 * @returns The injected list with `undefined` captures removed.
 */
function createInjectedStatements(
  capture: Statement | undefined,
  args: Statement,
  traced: Statement,
  call: Statement,
  publish: Statement,
): Statement[] {
  return [capture, args, traced, call, publish].filter(
    (statement): statement is Statement => statement !== undefined,
  )
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

export {
  createOuterArgumentsCapture,
  createArgumentsStatement,
  createTracedStatement,
  createCallStatement,
  createPublishStatement,
  createInjectedStatements,
}
