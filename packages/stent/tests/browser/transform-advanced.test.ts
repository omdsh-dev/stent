import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  createBrowserTransform,
  resolvePackageIdentity,
} from '#src/browser/index'
import type { StentPatchStub } from '#src/types'

vi.setConfig({ testTimeout: 10_000 })

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

const ALL_MATCHES = 2
const SINGLE_MATCH = 1

interface TestTarget {
  readonly module: string
  readonly versionRange: string
  readonly filePath?: string
  readonly functionQuery?: {
    readonly functionName?: string
    readonly methodName?: string
    readonly expressionName?: string
    readonly kind?: string
    readonly index?: number | null
  }
  readonly astQuery?: string
  readonly index?: number | null
}

interface TestPatch {
  readonly id: string
  readonly target: TestTarget
  readonly operation: string
  readonly required?: boolean
  readonly priority?: number
}

function isPatchStub(value: unknown): value is StentPatchStub {
  if (typeof value !== 'object' || value === null || !('target' in value)) {
    return false
  }
  return typeof value.target === 'object' && value.target !== null
}

const asPatchStub = (value: unknown): StentPatchStub => {
  if (isPatchStub(value)) {
    return value
  }
  throw new Error('expected a patch stub')
}

const patchFor = (
  id: string,
  filePath: string,
  functionQuery: NonNullable<TestTarget['functionQuery']>,
): TestPatch => ({
  ...patch,
  id,
  target: { ...patch.target, filePath, functionQuery },
})

const getterPatch = patchFor('web/getter-before', 'accessors.js', {
  methodName: 'value',
  kind: 'Sync' as const,
})
const setterPatch = patchFor('web/setter-before', 'accessors.js', {
  methodName: 'name',
  kind: 'Sync' as const,
})
const collisionPatch = patchFor('web/collision-before', 'collision.js', {
  functionName: 'readOuter',
  kind: 'Sync' as const,
})
const argsAllPatch = patchFor('web/args-all', 'args-all.js', {
  expressionName: 'bad',
  kind: 'Sync' as const,
})
const argsShadowedPatch = patchFor('web/args-shadowed', 'args-shadowed.cjs', {
  expressionName: 'f',
  kind: 'Sync' as const,
})

const createTransform = (
  patches: readonly TestPatch[],
  resolve: typeof resolvePackageIdentity = resolvePackageIdentity,
): ReturnType<typeof createBrowserTransform> =>
  createBrowserTransform({
    patches: patches.map((patchStub) => asPatchStub(patchStub)),
    resolve,
  })

function requireOutput<Value>(output: Value | null): Value {
  if (output === null) {
    throw new Error('expected transform output')
  }
  return output
}

const multiId = `${fixtureDir}multi.mjs`

const multiTarget = {
  module: 'stent-target-fixture',
  versionRange: '^1.0.0',
  filePath: 'multi.mjs',
}

const badIndexStub = {
  id: 'web/bad-index',
  operation: 'before',
  target: { ...multiTarget, astQuery: 'FunctionDeclaration', index: -1 },
}
const badFqIndexStub = {
  id: 'web/bad-fq-index',
  operation: 'before',
  target: {
    ...multiTarget,
    functionQuery: { methodName: 'close', kind: 'Sync', index: 1.5 },
  },
}

const multiTransform = (
  target: TestTarget,
): ReturnType<typeof createBrowserTransform> =>
  createTransform([{ id: 'web/multi', operation: 'before', target }])

const evaluateTarget = async (
  target: TestTarget,
): Promise<{ readonly code: string }> =>
  requireOutput(
    multiTransform(target)(await readFile(multiId, 'utf8'), multiId),
  )

const occurrencesOf = (code: string, needle: string): number => {
  const matches = code.match(new RegExp(needle, 'gu')) ?? []
  return matches.length
}

const accessorsSource = [
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

describe('createBrowserTransform accessors', () => {
  it('transforms object-literal and class getters/setters', () => {
    expect.hasAssertions()
    const transform = createTransform([getterPatch, setterPatch])
    const id = `${fixtureDir}accessors.js`
    const output = requireOutput(transform(accessorsSource, id))
    expect(output.code).toContain('id: "web/getter-before"')
    expect(output.code).toContain('id: "web/setter-before"')
    expect(output.code).toContain('return this._v')
    expect(output.code).toContain('this._name = v')
  })
})

describe('createBrowserTransform argument capture', () => {
  it('renames colliding injected identifiers', () => {
    expect.hasAssertions()
    const transform = createTransform([collisionPatch])
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

  it('rewrites every outer arguments reference', () => {
    expect.hasAssertions()
    const transform = createTransform([argsAllPatch])
    const id = `${fixtureDir}args-all.js`
    const source =
      'export const bad = () => { const first = arguments[0]; return arguments[1] }'
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('stentOuterArguments[0]')
    expect(output.code).toContain('stentOuterArguments[1]')
    expect(output.code).not.toContain('return arguments[1]')
  })
})

describe('createBrowserTransform shadowed arguments', () => {
  it('preserves arguments shadowing in nested arrows', () => {
    expect.hasAssertions()
    const transform = createTransform([argsShadowedPatch])
    const id = `${fixtureDir}args-shadowed.cjs`
    const source =
      'const f = () => { const g = (arguments) => arguments[0]; return g(1) }\nmodule.exports = { f }'
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('arguments => arguments[0]')
    expect(output.code).not.toContain('stentOuterArguments')
  })
})

describe('multi-match selection default behavior', () => {
  it('selects every function by default (name query)', async () => {
    expect.hasAssertions()
    const output = await evaluateTarget({
      ...multiTarget,
      functionQuery: { methodName: 'close', kind: 'Sync' },
    })
    expect(occurrencesOf(output.code, 'web/multi')).toStrictEqual(ALL_MATCHES)
  })

  it('selects every function by default (raw astQuery)', async () => {
    expect.hasAssertions()
    const output = await evaluateTarget({
      ...multiTarget,
      astQuery: 'ClassBody > [key.name="close"] > FunctionExpression',
    })
    expect(occurrencesOf(output.code, 'web/multi')).toStrictEqual(ALL_MATCHES)
  })
})

describe('multi-match selection indexed targets', () => {
  it('selects the index-th match when a name query carries an index', async () => {
    expect.hasAssertions()
    const first = await evaluateTarget({
      ...multiTarget,
      functionQuery: { methodName: 'close', kind: 'Sync', index: 0 },
    })
    expect(occurrencesOf(first.code, 'web/multi')).toStrictEqual(SINGLE_MATCH)
    expect(first.code.indexOf('web/multi')).toBeLessThan(
      first.code.indexOf('beta:'),
    )

    const second = await evaluateTarget({
      ...multiTarget,
      functionQuery: { methodName: 'close', kind: 'Sync', index: 1 },
    })
    expect(occurrencesOf(second.code, 'web/multi')).toStrictEqual(SINGLE_MATCH)
    expect(second.code.indexOf('web/multi')).toBeGreaterThan(
      second.code.indexOf('alpha:'),
    )
  })

  it('forwards target.index for raw astQuery targets', async () => {
    expect.hasAssertions()
    const output = await evaluateTarget({
      ...multiTarget,
      astQuery: 'ClassBody > [key.name="close"] > FunctionExpression',
      index: 1,
    })
    expect(occurrencesOf(output.code, 'web/multi')).toStrictEqual(SINGLE_MATCH)
    expect(output.code.indexOf('web/multi')).toBeGreaterThan(
      output.code.indexOf('alpha:'),
    )
  })
})

describe('multi-match selection validation errors', () => {
  it('rejects malformed index fields at build time', () => {
    expect.hasAssertions()
    expect(() => createTransform([badIndexStub])).toThrow(/target\.index/u)
    expect(() => createTransform([badFqIndexStub])).toThrow(
      /functionQuery\.index/u,
    )
  })

  it('rejects constructor targets loudly', async () => {
    expect.hasAssertions()
    const source = await readFile(multiId, 'utf8')
    expect(() =>
      multiTransform({
        ...multiTarget,
        astQuery: 'ClassBody > [key.name="constructor"] > FunctionExpression',
      })(source, multiId),
    ).toThrow(/constructor targets are not supported/u)
    expect(() =>
      multiTransform({
        ...multiTarget,
        functionQuery: { methodName: 'constructor', kind: 'Sync' },
      })(source, multiId),
    ).toThrow(/constructor targets are not supported/u)
  })
})
