/**
 * Stent dynamic matcher registration proof: every scenario runs in a fresh
 * child process because the synchronous module hooks cannot be unregistered and
 * the transformed module cache must not leak between scenarios.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** Child exit status for a completed scenario. */
const EXIT_SUCCESS = 0

const runner = fileURLToPath(new URL('multi-install.mjs', import.meta.url))

/** Run one registration scenario in a child process and return its stdout. */
function runScenario(name: string): string {
  /* Tsconfig (whose paths lack these packages); the child must resolve
     against this repo's own tsconfig so source-mode imports stay on src. */
  const childEnv = { ...process.env }
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', runner, name],
    {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      encoding: 'utf8',
      env: childEnv,
    },
  )
  expect(
    result.status,
    `scenario ${name} exited 0\n${result.stdout}\n${result.stderr}`,
  ).toBe(EXIT_SUCCESS)
  return result.stdout
}

describe('stent dynamic matcher registrations (child processes)', () => {
  it(
    'merges multiple plugin registrations into one matcher',
    { timeout: 60_000 },
    () => {
      expect.hasAssertions()
      const out = runScenario('registered')
      expect(out).toContain('PASS registered add(2,3): 23')
      expect(out).toContain('PASS registered greet(world): "hello WORLD"')
    },
  )

  it(
    'only registered patches participate in an initial load',
    { timeout: 60_000 },
    () => {
      expect.hasAssertions()
      const out = runScenario('disposeFirst')
      expect(out).toContain('PASS after disposeA add(2,3): 5')
      expect(out).toContain('PASS after disposeA greet(world): "hello WORLD"')
    },
  )

  it('orders dynamic registrations by priority', { timeout: 60_000 }, () => {
    expect.hasAssertions()
    const out = runScenario('stackedGreet')
    expect(out).toContain('PASS stacked greet(world): "hello worldAB"')
  })
})

describe('stent dynamic matcher registrations through require()', () => {
  it(
    'applies multiple registrations through the CJS compile hook',
    { timeout: 60_000 },
    () => {
      expect.hasAssertions()
      const out = runScenario('registeredCjs')
      expect(out).toContain('PASS registered cjs add(2,3): 23')
      expect(out).toContain('PASS registered cjs greet(world): "hello WORLD"')
    },
  )

  it(
    'omits unregistered patches from the CJS matcher',
    { timeout: 60_000 },
    () => {
      expect.hasAssertions()
      const out = runScenario('disposeFirstCjs')
      expect(out).toContain('PASS after disposeA cjs add(2,3): 5')
      expect(out).toContain(
        'PASS after disposeA cjs greet(world): "hello WORLD"',
      )
    },
  )
})
