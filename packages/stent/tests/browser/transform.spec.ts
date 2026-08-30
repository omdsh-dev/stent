import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  createBrowserTransform,
  repoSourceResolver,
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

describe('createBrowserTransform validation', () => {
  const createInvalid = (value: StentPatchStub): unknown => {
    return createTransform([value])
  }

  it('rejects malformed static fields instead of installing a never-matching config', () => {
    expect(() => createInvalid({ ...patch, id: 'has space' })).toThrow(
      /patch id/,
    )
    expect(() =>
      createInvalid({
        ...patch,
        target: { ...patch.target, module: '' },
      }),
    ).toThrow(/module/)
    expect(() =>
      createInvalid({
        ...patch,
        target: { ...patch.target, versionRange: '' },
      }),
    ).toThrow(/versionRange/)
    expect(() =>
      createInvalid({
        ...patch,
        target: { ...patch.target, filePath: 42 as never },
      }),
    ).toThrow(/filePath/)
    expect(() =>
      createInvalid({
        ...patch,
        target: {
          ...patch.target,
          filePath: undefined,
          filePaths: [],
        } as never,
      }),
    ).toThrow(/filePaths/)
    expect(() =>
      createInvalid({
        ...patch,
        target: {
          ...patch.target,
          filePath: undefined,
          filePaths: 42 as never,
        } as never,
      }),
    ).toThrow(/filePaths/)
  })

  it('accepts a valid patch and returns a transform function', () => {
    expect(createTransform([patch])).toEqual(expect.any(Function))
  })
})

describe('createBrowserTransform', () => {
  it('transforms installed-package modules through their nearest package.json resolver', () => {
    const transform = createTransform([patch])
    const id = `${fixtureDir}index.mjs`
    const source = readFileSync(id, 'utf8')
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('globalThis["__stentBridge"]')
    expect(output.code).toContain('id: "web/before-add"')
    expect(output.code).toContain('return a + b')
  })

  it('returns null for modules no instrumentation targets', () => {
    const transform = createTransform([patch])
    const output = transform(
      'export const x = 1',
      '/tmp/other-pkg/lib/index.js',
    )
    expect(output).toBeNull()
  })

  it('repoSourceResolver maps source-tree ids to the package identity', () => {
    const packageRoot = ['/repo', 'packages', 'client', 'x'].join('/')
    const resolver = repoSourceResolver({
      packageName: '@example/client-x',
      packageRoot,
      version: '0.0.1',
    })
    expect(resolver(`${packageRoot}/src/client/index.ts`)).toEqual({
      name: '@example/client-x',
      version: '0.0.1',
      path: 'src/client/index.ts',
    })
    expect(
      resolver(
        `${['/repo', 'packages', 'client', 'y'].join('/')}/src/client/index.ts`,
      ),
    ).toBeUndefined()
  })

  it('transforms source-tree modules through repoSourceResolver', () => {
    const root = fixtureDir.replace(/\/$/, '')
    const transform = createTransform(
      [patch],
      repoSourceResolver({
        packageName: 'stent-target-fixture',
        packageRoot: root,
        version: '1.0.0',
      }),
    )
    const id = `${root}/index.mjs`
    const source = readFileSync(id, 'utf8')
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('globalThis["__stentBridge"]')
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
    const transform = createTransform([patchTsx])
    const id = `${fixtureDir}jsx-target.tsx`
    const source = readFileSync(id, 'utf8')
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('globalThis["__stentBridge"]')
    expect(output.code).not.toContain('<div>')
    expect(output.code).not.toContain('React.createElement')
    expect(output.code).toContain('react/jsx-runtime')
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
    const transform = createTransform([patchTs])
    const id = `${fixtureDir}ts-target.ts`
    const source = readFileSync(id, 'utf8')
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('globalThis["__stentBridge"]')
    expect(output.code).not.toContain(': number')
    expect(output.code).toContain('return a + b')
  })
})
