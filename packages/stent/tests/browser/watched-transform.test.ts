import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createWatchedBrowserTransform,
  resolvePackageIdentity,
} from '#src/browser/index'

vi.setConfig({ testTimeout: 10_000 })

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

const FIRST_INDEX = 0

const makePatchesRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'stent-watched-'))
  roots.push(root)
  return root
}

const patchesFile = async (entries: unknown): Promise<string> => {
  const root = await makePatchesRoot()
  const filePath = path.join(root, 'stent.patches.json')
  if (typeof entries === 'string') {
    await writeFile(filePath, entries)
  } else {
    await writeFile(filePath, JSON.stringify(entries))
  }
  return filePath
}

const createWatched = (
  patchesPath: string,
): ReturnType<typeof createWatchedBrowserTransform> =>
  createWatchedBrowserTransform({
    patchesPath,
    resolve: resolvePackageIdentity,
  })

const stubTransform = async (): Promise<{
  transform: ReturnType<typeof createWatchedBrowserTransform>
  patchesPath: string
}> => {
  const patchesPath = await patchesFile([stub])
  return { transform: createWatched(patchesPath), patchesPath }
}

const cleanupRoots = async (): Promise<void> => {
  await Promise.all(
    roots.splice(FIRST_INDEX).map(async (root) => {
      await rm(root, { recursive: true, force: true })
    }),
  )
}

function requireOutput<Value>(output: Value | null): Value {
  if (output === null) {
    throw new Error('expected transform output')
  }
  return output
}

const expectTransformFailure = (
  transform: ReturnType<typeof createWatchedBrowserTransform>,
  expectedMessage: string,
): void => {
  expect(() => transform('export const x = 1', '/tmp/x/index.js')).toThrow(
    expectedMessage,
  )
}

const expectFailureForPatches = async (
  entries: unknown,
  expectedMessage: string,
): Promise<void> => {
  const transform = createWatched(await patchesFile(entries))
  expectTransformFailure(transform, expectedMessage)
}

describe('createWatchedBrowserTransform file-backed patch set', () => {
  afterEach(cleanupRoots)

  it('transforms matching modules from the patch file', async () => {
    expect.hasAssertions()
    const { transform } = await stubTransform()
    const source = await readFile(`${fixtureDir}index.mjs`, 'utf8')
    const output = requireOutput(transform(source, `${fixtureDir}index.mjs`))
    expect(output.code).toContain('globalThis["__stentBridge"]')
    expect(output.code).toContain('id: "web/before-add"')
    expect(output.code).toContain('operation: "before"')
    expect(output.code).toContain('return a + b')
  })

  it('returns null for modules no patch targets', async () => {
    expect.hasAssertions()
    const { transform } = await stubTransform()
    expect(
      transform('export const x = 1', '/tmp/other-pkg/lib/index.js'),
    ).toBeNull()
  })
})

describe('createWatchedBrowserTransform watch graph registration', () => {
  afterEach(cleanupRoots)

  it('registers the patches file in the watch graph', async () => {
    expect.hasAssertions()
    const { transform, patchesPath } = await stubTransform()
    const watched: string[] = []
    const addWatchFile = (file: string): void => {
      watched.push(file)
    }
    transform(
      await readFile(`${fixtureDir}index.mjs`, 'utf8'),
      `${fixtureDir}index.mjs`,
      addWatchFile,
    )
    /* A patch edit can make a previously unmatched module match, so the
       watch registration must not depend on the module matching. */
    transform('export const x = 1', '/tmp/other-pkg/lib/index.js', addWatchFile)
    expect(watched).toStrictEqual([patchesPath, patchesPath])
  })
})

describe('createWatchedBrowserTransform rebuild behavior', () => {
  afterEach(cleanupRoots)

  it('rebuilds the matcher when patches change', async () => {
    expect.hasAssertions()
    const { transform, patchesPath } = await stubTransform()
    const source = await readFile(`${fixtureDir}index.mjs`, 'utf8')
    expect(
      requireOutput(transform(source, `${fixtureDir}index.mjs`)).code,
    ).toContain('operation: "before"')

    await writeFile(
      patchesPath,
      JSON.stringify([{ ...stub, id: 'web/after-add', operation: 'after' }]),
    )
    expect(
      requireOutput(transform(source, `${fixtureDir}index.mjs`)).code,
    ).toContain('id: "web/after-add"')
    expect(
      requireOutput(transform(source, `${fixtureDir}index.mjs`)).code,
    ).toContain('operation: "after"')

    // An emptied patch set leaves the module untouched.
    await writeFile(patchesPath, '[]')
    expect(transform(source, `${fixtureDir}index.mjs`)).toBeNull()
  })

  it('fails loud on abnormal patches files', async () => {
    expect.hasAssertions()
    const missingRoot = await makePatchesRoot()
    const missing = createWatched(path.join(missingRoot, 'absent.json'))
    expectTransformFailure(missing, 'cannot read watched patches file')
    await expectFailureForPatches(
      'not json {',
      'cannot parse watched patches file',
    )
    await expectFailureForPatches({ id: 'x' }, 'JSON array of patch stubs')
    await expectFailureForPatches(
      [{ id: 'web/x' }],
      'entry 0 must be a patch stub object with a target',
    )
    await expectFailureForPatches([{ ...stub, id: 'has space' }], 'patch id')
  })
})
