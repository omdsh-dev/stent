// The test kit: runPatchFixture spawns a fresh child that bootstraps the
// patches, imports the entry, runs its default export, and reports the
// result (or thrown error) plus the load-time binding records — the shape a
// hand-rolled child runner produces, without the per-package boilerplate.

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runPatchFixture } from '../../src/testing/testkit.ts'

/** The fixture entry, as an absolute file URL the child can import. */
const entry = new URL('../fixtures/testkit-entry.mjs', import.meta.url).href

/** Repository root: the child resolves tsx and workspace packages from here. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** The target the fixture module lives under (stent-target-fixture). */
const target = {
  module: 'stent-target-fixture',
  versionRange: '^1.0.0',
  filePath: 'index.mjs',
}

describe('runPatchFixture', () => {
  it('bootstraps patches, runs the entry, and reports bindings', () => {
    const outcome = runPatchFixture({
      cwd: repoRoot,
      patches: [
        {
          id: 'testkit/after-add',
          target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
          operation: 'after',
        },
      ],
      entry,
      args: { a: 2, b: 3 },
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toEqual({ sum: 5 })
    // The binding record is the child's own: module, package-relative file,
    // and the rewritten node count.
    expect(outcome.bindings['testkit/after-add']).toEqual([
      { module: 'stent-target-fixture', file: 'index.mjs', nodes: 1 },
    ])
  })

  it('reports a thrown error with its message preserved', () => {
    const outcome = runPatchFixture({
      cwd: repoRoot,
      patches: [
        {
          id: 'testkit/after-add',
          target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
          operation: 'after',
        },
      ],
      entry,
      args: { throw: 'command aborted\ncompleted step: 1/5\n' },
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.result).toBeUndefined()
    // The enriched-error shape the node-half specs assert: the message
    // travels verbatim across the process boundary.
    expect(outcome.error).toEqual({ name: 'Error', message: 'command aborted\ncompleted step: 1/5\n' })
  })

  it('reports an unbound patch as an empty binding list', () => {
    const outcome = runPatchFixture({
      cwd: repoRoot,
      patches: [
        {
          id: 'testkit/no-match',
          target: { ...target, filePath: 'nope.mjs', functionQuery: { functionName: 'add', kind: 'Sync' } },
          operation: 'before',
        },
      ],
      entry,
      args: { a: 1, b: 1 },
    })
    expect(outcome.result).toEqual({ sum: 2 })
    expect(outcome.bindings['testkit/no-match']).toEqual([])
  })

  it('throws with the child stderr when the child cannot boot', () => {
    expect(() =>
      runPatchFixture({
        cwd: repoRoot,
        patches: [
          {
            id: 'testkit/bad',
            target: { module: '', versionRange: '*', filePath: 'x.js' },
            operation: 'before',
          },
        ],
        entry,
      }),
    ).toThrow(/child exited/)
  })
})
