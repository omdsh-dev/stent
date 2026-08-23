import {
  createBrowserTransform,
  repoSourceResolver,
  nodeModulesResolver,
  patchInstrumentation,
} from '../../src/index.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('../fixtures/node_modules/stent-target-fixture/', import.meta.url))

const patch = {
  id: 'web/before-add',
  target: {
    module: 'stent-target-fixture',
    versionRange: '^1.0.0',
    filePath: 'index.mjs',
    functionQuery: { functionName: 'add', kind: 'Sync' as const },
  },
  operation: 'before' as const,
  handler: () => {},
}

describe('patchInstrumentation validation', () => {
  it('rejects malformed static fields instead of installing a never-matching config', () => {
    expect(() => patchInstrumentation({ ...patch, id: 'has space' })).toThrow(/patch id/)
    expect(() =>
      patchInstrumentation({
        ...patch,
        target: { ...patch.target, module: '' },
      }),
    ).toThrow(/module/)
    expect(() =>
      patchInstrumentation({
        ...patch,
        target: { ...patch.target, versionRange: '' },
      }),
    ).toThrow(/versionRange/)
    expect(() =>
      patchInstrumentation({
        ...patch,
        target: { ...patch.target, filePath: 42 as never },
      }),
    ).toThrow(/filePath/)
    expect(() =>
      patchInstrumentation({
        ...patch,
        operation: 'sideways' as never,
      }),
    ).toThrow(/operation/)
  })

  it('accepts a valid patch and returns the instrumentation config', () => {
    const config = patchInstrumentation(patch)
    expect(config.channelName).toBe('web/before-add')
    expect(config.module).toEqual({ name: 'stent-target-fixture', versionRange: '^1.0.0', filePath: 'index.mjs' })
    expect(config.transform).toBe('stent')
    expect(config.astQuery).toContain('FunctionDeclaration[id.name="add"]')
  })
})

describe('createBrowserTransform', () => {
  it('transforms installed-package modules through nodeModulesResolver', () => {
    const transform = createBrowserTransform([patchInstrumentation(patch)], nodeModulesResolver())
    const id = `${fixtureDir}index.mjs`
    const source = readFileSync(id, 'utf8')
    const output = transform(source, id)
    expect(output).not.toBeNull()
    expect(output!.code).toContain('globalThis["__stentBridge"]')
    expect(output!.code).toContain('id: "web/before-add"')
    // The original body must be preserved inside the traced closure.
    expect(output!.code).toContain('return a + b')
  })

  it('returns null for modules no instrumentation targets', () => {
    const transform = createBrowserTransform([patchInstrumentation(patch)], nodeModulesResolver())
    const output = transform('export const x = 1', '/tmp/other-pkg/lib/index.js')
    expect(output).toBeNull()
  })

  it('repoSourceResolver maps source-tree ids to the package identity', () => {
    const packageRoot = ['/repo', 'packages', 'client', 'x'].join('/')
    const resolver = repoSourceResolver('@example/client-x', packageRoot, '0.0.1')
    expect(resolver(`${packageRoot}/src/client/index.ts`)).toEqual({
      name: '@example/client-x',
      version: '0.0.1',
      path: 'src/client/index.ts',
    })
    expect(resolver(`${['/repo', 'packages', 'client', 'y'].join('/')}/src/client/index.ts`)).toBeUndefined()
  })

  it('transforms source-tree modules through repoSourceResolver', () => {
    const root = fixtureDir.replace(/\/$/, '')
    const transform = createBrowserTransform(
      [patchInstrumentation(patch)],
      repoSourceResolver('stent-target-fixture', root, '1.0.0'),
    )
    const id = `${root}/index.mjs`
    const source = readFileSync(id, 'utf8')
    const output = transform(source, id)
    expect(output).not.toBeNull()
    expect(output!.code).toContain('globalThis["__stentBridge"]')
  })

  it('strips TypeScript annotations and JSX before transforming .tsx sources', () => {
    const patchTsx = {
      ...patch,
      id: 'web/tsx-before',
      target: {
        ...patch.target,
        filePath: 'jsx-target.tsx',
        functionQuery: { functionName: 'renderName', kind: 'Sync' as const },
      },
    }
    const transform = createBrowserTransform([patchInstrumentation(patchTsx)], nodeModulesResolver())
    const id = `${fixtureDir}jsx-target.tsx`
    const source = readFileSync(id, 'utf8')
    const output = transform(source, id)
    expect(output).not.toBeNull()
    expect(output!.code).toContain('globalThis["__stentBridge"]')
    expect(output!.code).not.toContain('<div>')
    // The source has no React import: the automatic runtime must keep the
    // emitted JSX self-contained instead of referencing an undefined React.
    expect(output!.code).not.toContain('React.createElement')
    expect(output!.code).toContain('react/jsx-runtime')
  })

  it('strips TypeScript annotations before transforming .ts sources', () => {
    const patchTs = {
      ...patch,
      id: 'web/ts-before',
      target: {
        ...patch.target,
        filePath: 'ts-target.ts',
        functionQuery: { functionName: 'addTs', kind: 'Sync' as const },
      },
    }
    const transform = createBrowserTransform([patchInstrumentation(patchTs)], nodeModulesResolver())
    const id = `${fixtureDir}ts-target.ts`
    const source = readFileSync(id, 'utf8')
    const output = transform(source, id)
    expect(output).not.toBeNull()
    expect(output!.code).toContain('globalThis["__stentBridge"]')
    expect(output!.code).not.toContain(': number')
    // The original body survives inside the traced closure.
    expect(output!.code).toContain('return a + b')
  })

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
    const transform = createBrowserTransform(
      [patchInstrumentation(patchGetter), patchInstrumentation(patchSetter)],
      nodeModulesResolver(),
    )
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
    const output = transform(source, id)
    expect(output).not.toBeNull()
    expect(output!.code).toContain('id: "web/getter-before"')
    expect(output!.code).toContain('id: "web/setter-before"')
    // The original accessor bodies survive inside the traced closures.
    expect(output!.code).toContain('return this._v')
    expect(output!.code).toContain('this._name = v')
  })

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
    const transform = createBrowserTransform([patchInstrumentation(patchCollision)], nodeModulesResolver())
    const id = `${fixtureDir}collision.js`
    const source = ['const stentCall = "outer"', 'export function readOuter() { return stentCall }'].join('\n')
    const output = transform(source, id)
    expect(output).not.toBeNull()
    // The injected record variable must not shadow the module-level binding
    // the moved body still resolves.
    expect(output!.code).toContain('stentCall_1')
    expect(output!.code).toContain('const stentCall = "outer"')
    expect(output!.code).toContain('return stentCall')
  })

  it('preserves an arrow body reading the enclosing arguments object', () => {
    const patchArgs = {
      ...patch,
      id: 'web/args-keep',
      target: {
        ...patch.target,
        filePath: 'args-arrow.js',
        functionQuery: { expressionName: 'bad', kind: 'Sync' as const },
      },
    }
    const transform = createBrowserTransform([patchInstrumentation(patchArgs)], nodeModulesResolver())
    const id = `${fixtureDir}args-arrow.js`
    const source = 'function wrap() { return (x) => x + arguments[0] }\nexport const bad = () => arguments[0]'
    const output = transform(source, id)
    expect(output).not.toBeNull()
    // The arrow is transformed, and the outer `arguments` reference is
    // preserved through a capture statement before the traced body.
    expect(output!.code).toContain('id: "web/args-keep"')
    expect(output!.code).toContain('stentOuterArguments = arguments')
    expect(output!.code).not.toContain('return arguments')
  })
})

describe('multi-match selection', () => {
  const multiId = `${fixtureDir}multi.mjs`
  const multiSource = (): string => readFileSync(multiId, 'utf8')
  const multiTarget = { module: 'stent-target-fixture', versionRange: '^1.0.0', filePath: 'multi.mjs' }
  const multiTransform = (target: Record<string, unknown>) =>
    createBrowserTransform(
      [patchInstrumentation({ id: 'web/multi', operation: 'before', target: target as never })],
      nodeModulesResolver(),
    )

  it('transforms every function the selector picks by default (name query)', () => {
    const output = multiTransform({ ...multiTarget, functionQuery: { methodName: 'close', kind: 'Sync' } })(
      multiSource(),
      multiId,
    )!
    expect(output.code.match(/web\/multi/g) ?? []).toHaveLength(2)
  })

  it('transforms every function the selector picks by default (raw astQuery)', () => {
    const output = multiTransform({ ...multiTarget, astQuery: 'ClassBody > [key.name="close"] > FunctionExpression' })(
      multiSource(),
      multiId,
    )!
    expect(output.code.match(/web\/multi/g) ?? []).toHaveLength(2)
  })

  it('selects the index-th match when a name query carries an index', () => {
    const first = multiTransform({ ...multiTarget, functionQuery: { methodName: 'close', kind: 'Sync', index: 0 } })(
      multiSource(),
      multiId,
    )!
    expect(first.code.match(/web\/multi/g) ?? []).toHaveLength(1)
    expect(first.code.indexOf('web/multi')).toBeLessThan(first.code.indexOf('beta:'))

    const second = multiTransform({ ...multiTarget, functionQuery: { methodName: 'close', kind: 'Sync', index: 1 } })(
      multiSource(),
      multiId,
    )!
    expect(second.code.match(/web\/multi/g) ?? []).toHaveLength(1)
    expect(second.code.indexOf('web/multi')).toBeGreaterThan(second.code.indexOf('alpha:'))
  })

  it('forwards target.index as the behavior bag for raw astQuery targets', () => {
    const output = multiTransform({
      ...multiTarget,
      astQuery: 'ClassBody > [key.name="close"] > FunctionExpression',
      index: 1,
    })(multiSource(), multiId)!
    expect(output.code.match(/web\/multi/g) ?? []).toHaveLength(1)
    expect(output.code.indexOf('web/multi')).toBeGreaterThan(output.code.indexOf('alpha:'))
  })

  it('rejects malformed index fields at instrumentation build time', () => {
    expect(() =>
      patchInstrumentation({
        id: 'web/bad-index',
        operation: 'before',
        target: { ...multiTarget, astQuery: 'FunctionDeclaration', index: -1 },
      }),
    ).toThrow(/target\.index/)
    expect(() =>
      patchInstrumentation({
        id: 'web/bad-fq-index',
        operation: 'before',
        target: { ...multiTarget, functionQuery: { methodName: 'close', kind: 'Sync', index: 1.5 } },
      }),
    ).toThrow(/functionQuery\.index/)
  })

  it('rejects constructor targets loudly instead of emitting unevaluatable code', () => {
    expect(() =>
      multiTransform({
        ...multiTarget,
        astQuery: 'ClassBody > [key.name="constructor"] > FunctionExpression',
      })(multiSource(), multiId),
    ).toThrow(/constructor targets are not supported/)
    expect(() =>
      multiTransform({
        ...multiTarget,
        functionQuery: { methodName: 'constructor', kind: 'Sync' },
      })(multiSource(), multiId),
    ).toThrow(/constructor targets are not supported/)
  })
})
