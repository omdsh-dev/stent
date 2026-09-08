import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const inheritedPath = process.env.PATH ?? ''
const EXIT_SUCCESS = 0
const EXECUTABLE_MODE = 0o755
const root = path.join(import.meta.dirname, '..', '..')
const launcher = path.join(root, 'lib', 'stent-dsh.js')
const probe = path.join(root, 'tests', 'fixtures', 'process-argv.mjs')
const shim = path.join(root, 'tests', 'fixtures', 'real-shell-shim')
const pnpm = path.join(root, 'tests', 'fixtures', 'fake-pnpm')

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('real launcher process contract', () => {
  it('forwards node argv and loader', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const result = run([
      '--dsh',
      process.execPath,
      probe,
      '--version',
      '--port',
      '8000',
    ])
    expect(result.status).toBe(EXIT_SUCCESS)
    expect(result.stdout).toContain('["--version","--port","8000"]')
  })

  it('answers --help without starting the child', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const result = run(['--dsh', process.execPath, probe, '--help'])
    expect(result.status).toBe(EXIT_SUCCESS)
    expect(result.stdout).toContain('Usage: stent-dsh')
    expect(result.stdout).not.toContain('"argv"')
  })

  it('uses directory pnpm forwarding', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const directory = mkdtempSync(path.join(tmpdir(), 'stent-dir-'))
    const command = path.join(directory, 'pnpm')
    copyFileSync(pnpm, command)
    chmodSync(command, EXECUTABLE_MODE)
    try {
      const result = run(['--dsh', directory, 'web'], {
        PATH: `${directory}${path.delimiter}${inheritedPath}`,
      })
      expect(result.status).toBe(EXIT_SUCCESS)
      expect(result.stdout).toContain(
        `PNPM-STUB argv=run --dir ${directory} dsh web`,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('diagnoses missing command', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const result = run(['--dsh', 'missing-stent-command'])
    expect(result.status).not.toBe(EXIT_SUCCESS)
    expect(result.stderr).toMatch(/cannot execute.*ENOENT/u)
  })

  it('runs executable shell shim', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    chmodSync(shim, EXECUTABLE_MODE)
    expect(run(['--dsh', shim, probe, 'shim']).status).toBe(EXIT_SUCCESS)
  })
})
