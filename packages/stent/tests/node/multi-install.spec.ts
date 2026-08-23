import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('./multi-install.mjs', import.meta.url))

function runScenario(name: string): string {
  // tsconfig; the child must resolve against this repo's own tsconfig.
  const childEnv = { ...process.env }
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', runner, name], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    encoding: 'utf8',
    env: childEnv,
  })
  expect(result.status, `scenario ${name} exited 0\n${result.stdout}\n${result.stderr}`).toBe(0)
  return result.stdout
}

describe('stent concurrent installations (child processes)', () => {
  it("transforms through each installation's own matcher", () => {
    const out = runScenario('concurrent')
    expect(out).toContain('PASS concurrent add(2,3): 23')
    expect(out).toContain('PASS concurrent greet(world): "hello WORLD"')
  })

  it('disposing an earlier installation leaves later ones intact', () => {
    const out = runScenario('disposeFirst')
    expect(out).toContain('PASS after disposeA add(2,3): 5')
    expect(out).toContain('PASS after disposeA greet(world): "hello WORLD"')
  })

  it('chains concurrent installations through the CJS _compile wrapper', () => {
    const out = runScenario('concurrentCjs')
    expect(out).toContain('PASS concurrent cjs add(2,3): 23')
    expect(out).toContain('PASS concurrent cjs greet(world): "hello WORLD"')
  })

  it('drops a disposed installation out of the CJS chain', () => {
    const out = runScenario('disposeFirstCjs')
    expect(out).toContain('PASS after disposeA cjs add(2,3): 5')
    expect(out).toContain('PASS after disposeA cjs greet(world): "hello WORLD"')
  })

  it('stacks cross-installation patches by installation order, not priority', () => {
    const out = runScenario('stackedGreet')
    expect(out).toContain('PASS stacked greet(world): "hello worldBA"')
  })
})
