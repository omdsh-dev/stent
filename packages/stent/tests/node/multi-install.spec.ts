import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('./multi-install.mjs', import.meta.url))

function runScenario(name: string): string {
  // tsconfig; the child must resolve against this repo's own tsconfig.
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
  ).toBe(0)
  return result.stdout
}

describe('stent dynamic matcher registrations (child processes)', () => {
  it('merges multiple plugin registrations into one matcher', () => {
    const out = runScenario('registered')
    expect(out).toContain('PASS registered add(2,3): 23')
    expect(out).toContain('PASS registered greet(world): "hello WORLD"')
  })

  it('only registered patches participate in an initial load', () => {
    const out = runScenario('disposeFirst')
    expect(out).toContain('PASS after disposeA add(2,3): 5')
    expect(out).toContain('PASS after disposeA greet(world): "hello WORLD"')
  })

  it('applies multiple registrations through the CJS compile hook', () => {
    const out = runScenario('registeredCjs')
    expect(out).toContain('PASS registered cjs add(2,3): 23')
    expect(out).toContain('PASS registered cjs greet(world): "hello WORLD"')
  })

  it('omits unregistered patches from the CJS matcher', () => {
    const out = runScenario('disposeFirstCjs')
    expect(out).toContain('PASS after disposeA cjs add(2,3): 5')
    expect(out).toContain('PASS after disposeA cjs greet(world): "hello WORLD"')
  })

  it('orders dynamic registrations by priority', () => {
    const out = runScenario('stackedGreet')
    expect(out).toContain('PASS stacked greet(world): "hello worldAB"')
  })
})
