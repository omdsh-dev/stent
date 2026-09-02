import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  createBrowserTransform,
  repoSourceResolver,
  resolvePackageIdentity,
} from '#src/browser/index'
import type { StentPatchStub } from '#src/types'

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

interface TestTarget {
  readonly module: string
  readonly versionRange: string
  readonly filePath?: string
  readonly filePaths?: readonly string[]
  readonly functionQuery?: TestFunctionQuery
  readonly astQuery?: string
  readonly index?: number | null
}

interface TestFunctionQuery {
  readonly functionName?: string
  readonly methodName?: string
  readonly expressionName?: string
  readonly kind?: string
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
  functionQuery: TestFunctionQuery,
): TestPatch => ({
  ...patch,
  id,
  target: { ...patch.target, filePath, functionQuery },
})

const createTransform = (
  patches: readonly TestPatch[],
  resolve: typeof resolvePackageIdentity = resolvePackageIdentity,
): ReturnType<typeof createBrowserTransform> =>
  createBrowserTransform({
    patches: patches.map((patchStub) => asPatchStub(patchStub)),
    resolve,
  })

const createInvalid = (
  value: unknown,
): ReturnType<typeof createBrowserTransform> =>
  createBrowserTransform({
    patches: [asPatchStub(value)],
    resolve: resolvePackageIdentity,
  })

function requireOutput<Value>(output: Value | null): Value {
  if (output === null) {
    throw new Error('expected transform output')
  }
  return output
}

describe('createBrowserTransform validation', () => {
  it(
    'rejects malformed static fields instead of installing a never-matching config',
    { timeout: 10_000 },
    () => {
      expect.hasAssertions()
      expect(() => createInvalid({ ...patch, id: 'has space' })).toThrow(
        /patch id/u,
      )
      expect(() =>
        createInvalid({
          ...patch,
          target: { ...patch.target, module: '' },
        }),
      ).toThrow(/module/u)
      expect(() =>
        createInvalid({
          ...patch,
          target: { ...patch.target, versionRange: '' },
        }),
      ).toThrow(/versionRange/u)
    },
  )

  it(
    'rejects mismatched file selector fields instead of installing a never-matching config',
    { timeout: 10_000 },
    () => {
      expect.hasAssertions()
      expect(() =>
        createInvalid({
          ...patch,
          target: { ...patch.target, filePath: 42 },
        }),
      ).toThrow(/filePath/u)
      expect(() =>
        createInvalid({
          ...patch,
          target: { ...patch.target, filePath: undefined, filePaths: [] },
        }),
      ).toThrow(/filePaths/u)
      expect(() =>
        createInvalid({
          ...patch,
          target: { ...patch.target, filePath: undefined, filePaths: 42 },
        }),
      ).toThrow(/filePaths/u)
    },
  )
})

describe('createBrowserTransform transforms installed packages', () => {
  it(
    'transforms installed-package modules through their nearest package.json resolver',
    { timeout: 10_000 },
    async () => {
      expect.hasAssertions()
      const transform = createTransform([patch])
      const id = `${fixtureDir}index.mjs`
      const source = await readFile(id, 'utf8')
      const output = requireOutput(transform(source, id))
      expect(output.code).toContain('globalThis["__stentBridge"]')
      expect(output.code).toContain('id: "web/before-add"')
      expect(output.code).toContain('return a + b')
    },
  )

  it(
    'returns null for modules no instrumentation targets',
    { timeout: 10_000 },
    () => {
      expect.hasAssertions()
      const transform = createTransform([patch])
      const output = transform(
        'export const x = 1',
        '/tmp/other-pkg/lib/index.js',
      )
      expect(output).toBeNull()
    },
  )

  it(
    'accepts a valid patch and returns a transform function',
    { timeout: 10_000 },
    () => {
      expect.hasAssertions()
      expect(createTransform([patch])).toStrictEqual(expect.any(Function))
    },
  )
})

describe('createBrowserTransform resolves source-tree identities', () => {
  it(
    'repoSourceResolver maps source-tree ids to the package identity',
    { timeout: 10_000 },
    () => {
      expect.hasAssertions()
      const packageRoot = ['/repo', 'packages', 'client', 'x'].join('/')
      const resolver = repoSourceResolver({
        packageName: '@example/client-x',
        packageRoot,
        version: '0.0.1',
      })
      expect(resolver(`${packageRoot}/src/client/index.ts`)).toStrictEqual({
        name: '@example/client-x',
        version: '0.0.1',
        path: 'src/client/index.ts',
      })
      expect(
        resolver(
          `${['/repo', 'packages', 'client', 'y'].join('/')}/src/client/index.ts`,
        ),
      ).toBeUndefined()
    },
  )

  it(
    'transforms source-tree modules through repoSourceResolver',
    { timeout: 10_000 },
    async () => {
      expect.hasAssertions()
      const root = fixtureDir.replace(/\/\$/u, '')
      const transform = createTransform(
        [patch],
        repoSourceResolver({
          packageName: 'stent-target-fixture',
          packageRoot: root,
          version: '1.0.0',
        }),
      )
      const id = `${root}/index.mjs`
      const source = await readFile(id, 'utf8')
      const output = requireOutput(transform(source, id))
      expect(output.code).toContain('globalThis["__stentBridge"]')
    },
  )
})

describe('createBrowserTransform strips TypeScript sources', () => {
  it(
    'strips TypeScript annotations and JSX before transforming .tsx sources',
    { timeout: 10_000 },
    async () => {
      expect.hasAssertions()
      const transform = createTransform([
        patchFor('web/tsx-before', 'jsx-target.tsx', {
          functionName: 'renderName',
          kind: 'Sync' as const,
        }),
      ])
      const id = `${fixtureDir}jsx-target.tsx`
      const source = await readFile(id, 'utf8')
      const output = requireOutput(transform(source, id))
      expect(output.code).toContain('globalThis["__stentBridge"]')
      expect(output.code).not.toContain('<div>')
      expect(output.code).not.toContain('React.createElement')
      expect(output.code).toContain('react/jsx-runtime')
    },
  )

  it(
    'strips TypeScript annotations before transforming .ts sources',
    { timeout: 10_000 },
    async () => {
      expect.hasAssertions()
      const transform = createTransform([
        patchFor('web/ts-before', 'ts-target.ts', {
          functionName: 'addTs',
          kind: 'Sync' as const,
        }),
      ])
      const id = `${fixtureDir}ts-target.ts`
      const source = await readFile(id, 'utf8')
      const output = requireOutput(transform(source, id))
      expect(output.code).toContain('globalThis["__stentBridge"]')
      expect(output.code).not.toContain(': number')
      expect(output.code).toContain('return a + b')
    },
  )
})
