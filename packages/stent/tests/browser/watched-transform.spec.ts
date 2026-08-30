import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createWatchedBrowserTransform,
  resolvePackageIdentity,
} from '../../src/browser/index.ts'

const fixtureDir = fileURLToPath(
  new URL('../fixtures/node_modules/stent-target-fixture/', import.meta.url),
)

const stub = {
  id: 'web/before-add',
  target: {
    module: 'stent-target-fixture',
    versionRange: '^1.0.0',
    filePath: 'index.mjs',
    functionQuery: { functionName: 'add', kind: 'Sync' },
  },
  operation: 'before',
}

const roots: string[] = []

function patchesFile(entries: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'stent-watched-'))
  roots.push(root)
  const path = join(root, 'stent.patches.json')
  if (typeof entries === 'string') {
    writeFileSync(path, entries)
  } else {
    writeFileSync(path, JSON.stringify(entries))
  }
  return path
}

function requireOutput<T>(output: T | null): T {
  if (output === null) {
    throw new Error('expected transform output')
  }
  return output
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('createWatchedBrowserTransform', () => {
  it('transforms matching modules from the file-backed patch set', () => {
    const path = patchesFile([stub])
    const transform = createWatchedBrowserTransform({
      patchesPath: path,
      resolve: resolvePackageIdentity,
    })
    const id = `${fixtureDir}index.mjs`
    const output = requireOutput(transform(readFileSync(id, 'utf8'), id))
    expect(output.code).toContain('globalThis["__stentBridge"]')
    expect(output.code).toContain('id: "web/before-add"')
    expect(output.code).toContain('operation: "before"')
    expect(output.code).toContain('return a + b')
  })

  it('returns null for modules no patch targets', () => {
    const path = patchesFile([stub])
    const transform = createWatchedBrowserTransform({
      patchesPath: path,
      resolve: resolvePackageIdentity,
    })
    expect(
      transform('export const x = 1', '/tmp/other-pkg/lib/index.js'),
    ).toBeNull()
  })

  it('registers the patches file in the watch graph for matching and unmatched modules alike', () => {
    const path = patchesFile([stub])
    const transform = createWatchedBrowserTransform({
      patchesPath: path,
      resolve: resolvePackageIdentity,
    })
    const watched: string[] = []
    const addWatchFile = (file: string): void => {
      watched.push(file)
    }
    transform(
      readFileSync(`${fixtureDir}index.mjs`, 'utf8'),
      `${fixtureDir}index.mjs`,
      addWatchFile,
    )
    // A patch edit can make a previously unmatched module match, so the
    // watch registration must not depend on the module matching.
    transform('export const x = 1', '/tmp/other-pkg/lib/index.js', addWatchFile)
    expect(watched).toEqual([path, path])
  })

  it('rebuilds the matcher when the patches file content changes', () => {
    const path = patchesFile([stub])
    const transform = createWatchedBrowserTransform({
      patchesPath: path,
      resolve: resolvePackageIdentity,
    })
    const id = `${fixtureDir}index.mjs`
    const source = readFileSync(id, 'utf8')
    expect(requireOutput(transform(source, id)).code).toContain(
      'operation: "before"',
    )

    writeFileSync(
      path,
      JSON.stringify([{ ...stub, id: 'web/after-add', operation: 'after' }]),
    )
    const output = requireOutput(transform(source, id))
    expect(output.code).toContain('id: "web/after-add"')
    expect(output.code).toContain('operation: "after"')

    // An emptied patch set leaves the module untouched.
    writeFileSync(path, '[]')
    expect(transform(source, id)).toBeNull()
  })

  it('fails loud on an unreadable or malformed patches file', () => {
    const root = mkdtempSync(join(tmpdir(), 'stent-watched-'))
    roots.push(root)
    const missing = createWatchedBrowserTransform({
      patchesPath: join(root, 'absent.json'),
      resolve: resolvePackageIdentity,
    })
    expect(() => missing('export const x = 1', '/tmp/x/index.js')).toThrow(
      /cannot read watched patches file/,
    )

    const notJson = createWatchedBrowserTransform({
      patchesPath: patchesFile('not json {'),
      resolve: resolvePackageIdentity,
    })
    expect(() => notJson('export const x = 1', '/tmp/x/index.js')).toThrow(
      /cannot parse watched patches file/,
    )

    const notArray = createWatchedBrowserTransform({
      patchesPath: patchesFile({ id: 'x' }),
      resolve: resolvePackageIdentity,
    })
    expect(() => notArray('export const x = 1', '/tmp/x/index.js')).toThrow(
      /JSON array of patch stubs/,
    )

    const noTarget = createWatchedBrowserTransform({
      patchesPath: patchesFile([{ id: 'web/x' }]),
      resolve: resolvePackageIdentity,
    })
    expect(() => noTarget('export const x = 1', '/tmp/x/index.js')).toThrow(
      /entry 0 must be a patch stub object with a target/,
    )

    const badId = createWatchedBrowserTransform({
      patchesPath: patchesFile([{ ...stub, id: 'has space' }]),
      resolve: resolvePackageIdentity,
    })
    expect(() => badId('export const x = 1', '/tmp/x/index.js')).toThrow(
      /patch id/,
    )
  })
})
