/* The test kit: runPatchFixture spawns a fresh child that registers patch
   metadata through the dynamic hooks, imports the entry, runs its default
   export, and reports the result (or thrown error) plus the load-time binding
   records - the shape a hand-rolled child runner produces, without the
   per-package boilerplate. */

import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { runPatchFixture as runFixture } from '#src/testing/testkit'

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

/** Fixture argument key for the first addend (read as `args.a`). */
const ADDEND_KEY = 'a'

/** Fixture argument key for the second addend (read as `args.b`). */
const AUGEND_KEY = 'b'

/** Exit code for a fixture run whose child booted and answered the envelope. */
const EXIT_SUCCESS = 0

function testRegistersPatchMetadata(): void {
  expect.hasAssertions()
  const outcome = runFixture({
    cwd: repoRoot,
    patches: [
      {
        id: 'testkit/after-add',
        target: {
          ...target,
          functionQuery: { functionName: 'add', kind: 'Sync' },
        },
        operation: 'after',
      },
    ],
    entry,
    args: { [ADDEND_KEY]: 2, [AUGEND_KEY]: 3 },
  })
  expect(outcome.exitCode).toBe(EXIT_SUCCESS)
  expect(outcome.error).toBeUndefined()
  expect(outcome.result).toStrictEqual({ sum: 5 })
  /* The binding record is the child's own: module, package-relative file,
     and the rewritten node count. */
  expect(outcome.bindings['testkit/after-add']).toStrictEqual([
    { module: 'stent-target-fixture', file: 'index.mjs', nodes: 1 },
  ])
}

function testReportsThrownError(): void {
  expect.hasAssertions()
  const outcome = runFixture({
    cwd: repoRoot,
    patches: [
      {
        id: 'testkit/after-add',
        target: {
          ...target,
          functionQuery: { functionName: 'add', kind: 'Sync' },
        },
        operation: 'after',
      },
    ],
    entry,
    args: { throw: 'command aborted\ncompleted step: 1/5\n' },
  })
  expect(outcome.exitCode).toBe(EXIT_SUCCESS)
  expect(outcome.result).toBeUndefined()
  /* The enriched-error shape the node-half specs assert: the message
     travels verbatim across the process boundary. */
  expect(outcome.error).toStrictEqual({
    name: 'Error',
    message: 'command aborted\ncompleted step: 1/5\n',
  })
}

function testReportsUnboundPatch(): void {
  expect.hasAssertions()
  const outcome = runFixture({
    cwd: repoRoot,
    patches: [
      {
        id: 'testkit/no-match',
        target: {
          ...target,
          filePath: 'nope.mjs',
          functionQuery: { functionName: 'add', kind: 'Sync' },
        },
        operation: 'before',
      },
    ],
    entry,
    args: { [ADDEND_KEY]: 1, [AUGEND_KEY]: 1 },
  })
  expect(outcome.result).toStrictEqual({ sum: 2 })
  expect(outcome.bindings['testkit/no-match']).toStrictEqual([])
}

function testThrowsWhenChildCannotBoot(): void {
  expect.hasAssertions()
  expect(() =>
    runFixture({
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
  ).toThrow(/child exited/u)
}

describe('runPatchFixture', () => {
  it(
    'registers patch metadata, runs the entry, and reports bindings',
    { timeout: 120_000 },
    testRegistersPatchMetadata,
  )

  it(
    'reports a thrown error with its message preserved',
    { timeout: 120_000 },
    testReportsThrownError,
  )

  it(
    'reports an unbound patch as an empty binding list',
    { timeout: 120_000 },
    testReportsUnboundPatch,
  )

  it(
    'throws with the child stderr when the child cannot boot',
    { timeout: 120_000 },
    testThrowsWhenChildCannotBoot,
  )
})
