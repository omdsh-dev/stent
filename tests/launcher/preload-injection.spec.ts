import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Direct preload probes verify that the preload is launcher-owned: a legacy
 * `STENT_CONFIG` variable alone cannot activate static hooks or claim a launch.
 * The installed launcher tests cover the active dynamic preload path. */
const preload = fileURLToPath(new URL('../../src/stent-dsh-preload.ts', import.meta.url))
const entry = fileURLToPath(new URL('../fixtures/preload-entry.mjs', import.meta.url))

const tempDir = mkdtempSync(join(tmpdir(), 'stent-preload-'))
const legacyConfigPath = join(tempDir, 'legacy-stent-config.json')

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/** Spawn the stent-dsh launcher shape and return the entry's stdout. */
function run(configEnv: string | undefined, profileEnv?: string): { stdout: string; stderr: string } {
  // tsconfig (whose paths lack these packages); children must resolve
  // against this repo's own tsconfig so source-mode imports stay on src.
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (configEnv === undefined) delete childEnv.STENT_CONFIG
  else childEnv.STENT_CONFIG = configEnv
  if (profileEnv === undefined) delete childEnv.STENT_PROFILE
  else childEnv.STENT_PROFILE = profileEnv
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--import', preload, entry], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    env: childEnv,
  })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  return { stdout: result.stdout, stderr: result.stderr }
}

describe('stent preload injection (Stent launcher shape)', () => {
  it('does not activate from STENT_CONFIG without the launcher capability', () => {
    const out = run(legacyConfigPath)
    expect(out.stdout).toContain('DIRECT-PRELOAD launch=false bindings=0 add(2,3)=5')
  })

  it('stays inert without STENT_CONFIG (host runs unmodified)', () => {
    const out = run(undefined)
    expect(out.stdout).toContain('DIRECT-PRELOAD launch=false bindings=0 add(2,3)=5')
  })

  it('prints no Stent activation marker for a direct preload', () => {
    const configured = run(legacyConfigPath)
    expect(configured.stderr).not.toContain('stent:')
    const inert = run(undefined)
    expect(inert.stderr).not.toContain('stent:')
  })

  it('does not resolve a profile replacement during a direct preload', () => {
    // 写入一个会在导入时失败的 profile 替代包，验证 source launcher 不会解析到这里。
    const profileDir = join(tempDir, 'profile')
    const stubDir = join(profileDir, 'node_modules', '@oh-my-dsh', 'stent')
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}\n')
    writeFileSync(
      join(stubDir, 'package.json'),
      JSON.stringify({
        name: '@oh-my-dsh/stent',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js' },
      }),
    )
    writeFileSync(join(stubDir, 'index.js'), "throw new Error('profile Stent package must not be imported')\n")

    const out = run(legacyConfigPath, profileDir)
    expect(out.stdout).toContain('DIRECT-PRELOAD launch=false bindings=0 add(2,3)=5')
  })
})
