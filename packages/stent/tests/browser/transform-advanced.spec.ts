import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  createBrowserTransform,
  resolvePackageIdentity,
} from '../../src/browser/index.ts'
import type { IdentityResolver } from '../../src/browser/index.ts'
import type { StentPatchStub } from '../../src/types.ts'

const fixtureDir = fileURLToPath(
  new URL('../fixtures/node_modules/stent-target-fixture/', import.meta.url),
)

const patch = {
  id: 'web/before-add',
  target: {
    module: 'stent-target-fixture',
    versionRange: '^1.0.0',
    filePath: 'index.mjs',
    functionQuery: { functionName: 'add', kind: 'Sync' as const },
  },
  operation: 'before' as const,
}

const createTransform = (
  patches: readonly StentPatchStub[],
  resolve: IdentityResolver = resolvePackageIdentity,
) => createBrowserTransform({ patches, resolve })

function requireOutput<T>(output: T | null): T {
  if (output === null) {
    throw new Error('expected transform output')
  }
  return output
}

describe('createBrowserTransform accessors', () => {
  it('transforms object-literal and class getters/setters', () => {
    const patchGetter = {
      ...patch,
      id: 'web/getter-before',
      target: {
        ...patch.target,
        filePath: 'accessors.js',
        functionQuery: { methodName: 'value', kind: 'Sync' as const },
      },
    }
    const patchSetter = {
      ...patch,
      id: 'web/setter-before',
      target: {
        ...patch.target,
        filePath: 'accessors.js',
        functionQuery: { methodName: 'name', kind: 'Sync' as const },
      },
    }
    const transform = createTransform([patchGetter, patchSetter])
    const id = `${fixtureDir}accessors.js`
    const source = [
      'export const obj = {',
      '  _v: 1,',
      '  get value() { return this._v },',
      '  set name(v) { this._name = v },',
      '}',
      'export class C {',
      '  _v = 1',
      '  get value() { return this._v }',
      '  set name(v) { this._name = v }',
      '}',
    ].join('\n')
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('id: "web/getter-before"')
    expect(output.code).toContain('id: "web/setter-before"')
    expect(output.code).toContain('return this._v')
    expect(output.code).toContain('this._name = v')
  })
})

describe('createBrowserTransform argument capture', () => {
  it('renames injected identifiers that collide with existing ones', () => {
    const patchCollision = {
      ...patch,
      id: 'web/collision-before',
      target: {
        ...patch.target,
        filePath: 'collision.js',
        functionQuery: { functionName: 'readOuter', kind: 'Sync' as const },
      },
    }
    const transform = createTransform([patchCollision])
    const id = `${fixtureDir}collision.js`
    const source = [
      'const stentCall = "outer"',
      'export function readOuter() { return stentCall }',
    ].join('\n')
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('stentCall_1')
    expect(output.code).toContain('const stentCall = "outer"')
    expect(output.code).toContain('return stentCall')
  })

  it('rewrites every outer arguments reference in an arrow body', () => {
    const patchArgs = {
      ...patch,
      id: 'web/args-all',
      target: {
        ...patch.target,
        filePath: 'args-all.js',
        functionQuery: { expressionName: 'bad', kind: 'Sync' as const },
      },
    }
    const transform = createTransform([patchArgs])
    const id = `${fixtureDir}args-all.js`
    const source =
      'export const bad = () => { const first = arguments[0]; return arguments[1] }'
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('stentOuterArguments[0]')
    expect(output.code).toContain('stentOuterArguments[1]')
    expect(output.code).not.toContain('return arguments[1]')
  })

  it('preserves arguments shadowing in nested arrows', () => {
    const patchArgs = {
      ...patch,
      id: 'web/args-shadowed',
      target: {
        ...patch.target,
        filePath: 'args-shadowed.cjs',
        functionQuery: { expressionName: 'f', kind: 'Sync' as const },
      },
    }
    const transform = createTransform([patchArgs])
    const id = `${fixtureDir}args-shadowed.cjs`
    const source =
      'const f = () => { const g = (arguments) => arguments[0]; return g(1) }\nmodule.exports = { f }'
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('arguments => arguments[0]')
    expect(output.code).not.toContain('stentOuterArguments')
  })
})

describe('multi-match selection', () => {
  const multiId = `${fixtureDir}multi.mjs`
  const multiSource = readFileSync(multiId, 'utf8')

  const multiTarget = {
    module: 'stent-target-fixture',
    versionRange: '^1.0.0',
    filePath: 'multi.mjs',
  }
  const multiTransform = (target: Record<string, unknown>) =>
    createTransform([
      { id: 'web/multi', operation: 'before', target: target as never },
    ])

  it('transforms every function the selector picks by default (name query)', () => {
    const output = requireOutput(
      multiTransform({
        ...multiTarget,
        functionQuery: { methodName: 'close', kind: 'Sync' },
      })(multiSource, multiId),
    )
    expect(output.code.match(/web\/multi/g) ?? []).toHaveLength(2)
  })

  it('transforms every function the selector picks by default (raw astQuery)', () => {
    const output = requireOutput(
      multiTransform({
        ...multiTarget,
        astQuery: 'ClassBody > [key.name="close"] > FunctionExpression',
      })(multiSource, multiId),
    )
    expect(output.code.match(/web\/multi/g) ?? []).toHaveLength(2)
  })

  it('selects the index-th match when a name query carries an index', () => {
    const first = requireOutput(
      multiTransform({
        ...multiTarget,
        functionQuery: { methodName: 'close', kind: 'Sync', index: 0 },
      })(multiSource, multiId),
    )
    expect(first.code.match(/web\/multi/g) ?? []).toHaveLength(1)
    expect(first.code.indexOf('web/multi')).toBeLessThan(
      first.code.indexOf('beta:'),
    )

    const second = requireOutput(
      multiTransform({
        ...multiTarget,
        functionQuery: { methodName: 'close', kind: 'Sync', index: 1 },
      })(multiSource, multiId),
    )
    expect(second.code.match(/web\/multi/g) ?? []).toHaveLength(1)
    expect(second.code.indexOf('web/multi')).toBeGreaterThan(
      second.code.indexOf('alpha:'),
    )
  })

  it('forwards target.index as the behavior bag for raw astQuery targets', () => {
    const output = requireOutput(
      multiTransform({
        ...multiTarget,
        astQuery: 'ClassBody > [key.name="close"] > FunctionExpression',
        index: 1,
      })(multiSource, multiId),
    )
    expect(output.code.match(/web\/multi/g) ?? []).toHaveLength(1)
    expect(output.code.indexOf('web/multi')).toBeGreaterThan(
      output.code.indexOf('alpha:'),
    )
  })

  it('rejects malformed index fields at instrumentation build time', () => {
    expect(() =>
      createTransform([
        {
          id: 'web/bad-index',
          operation: 'before',
          target: {
            ...multiTarget,
            astQuery: 'FunctionDeclaration',
            index: -1,
          },
        },
      ]),
    ).toThrow(/target\.index/)
    expect(() =>
      createTransform([
        {
          id: 'web/bad-fq-index',
          operation: 'before',
          target: {
            ...multiTarget,
            functionQuery: { methodName: 'close', kind: 'Sync', index: 1.5 },
          },
        },
      ]),
    ).toThrow(/functionQuery\.index/)
  })

  it('rejects constructor targets loudly instead of emitting unevaluatable code', () => {
    expect(() =>
      multiTransform({
        ...multiTarget,
        astQuery: 'ClassBody > [key.name="constructor"] > FunctionExpression',
      })(multiSource, multiId),
    ).toThrow(/constructor targets are not supported/)
    expect(() =>
      multiTransform({
        ...multiTarget,
        functionQuery: { methodName: 'constructor', kind: 'Sync' },
      })(multiSource, multiId),
    ).toThrow(/constructor targets are not supported/)
  })
})
