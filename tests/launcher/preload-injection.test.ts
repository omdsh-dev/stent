import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

/**
 * Direct preload probes verify that the preload is launcher-owned: a legacy
 * `STENT_CONFIG` variable alone cannot activate static hooks or claim a launch.
 * The installed launcher tests cover the active dynamic preload path.
 */
const repoRoot = path.join(import.meta.dirname, '..', '..')
const preload = path.join(repoRoot, 'src', 'stent-loader.ts')
const entry = path.join(repoRoot, 'tests', 'fixtures', 'preload-entry.mjs')

const tempDir = mkdtempSync(path.join(tmpdir(), 'stent-preload-'))
const legacyConfigPath = path.join(tempDir, 'legacy-stent-config.json')

const EXIT_SUCCESS = 0
const INERT_PRELOAD = 'DIRECT-PRELOAD launch=false bindings=0 add(2,3)=5'

interface PreloadRun {
  readonly stdout: string
  readonly stderr: string
}

/** Spawn the stent-dsh launcher shape and return the entry's stdout. */
function run(configEnv?: string, profileEnv?: string): PreloadRun {
  /* Children must resolve against this repo's own tsconfig — a foreign
     tsconfig's paths lack these packages — so source-mode imports stay on
     src. */
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (configEnv === undefined) {
    delete childEnv.STENT_CONFIG
  } else {
    childEnv.STENT_CONFIG = configEnv
  }
  if (profileEnv === undefined) {
    delete childEnv.STENT_PROFILE
  } else {
    childEnv.STENT_PROFILE = profileEnv
  }
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--import', preload, entry],
    { cwd: repoRoot, encoding: 'utf8', env: childEnv },
  )
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(EXIT_SUCCESS)
  return { stdout: result.stdout, stderr: result.stderr }
}

/** Write a profile Stent replacement that explodes when it is imported. */
function createExplodingProfileStent(parent: string): string {
  const profileDir = path.join(parent, 'profile')
  const stubDir = path.join(profileDir, 'node_modules', '@oh-my-dsh', 'stent')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), '{}\n')
  writeFileSync(
    path.join(stubDir, 'package.json'),
    JSON.stringify({
      name: '@oh-my-dsh/stent',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
    }),
  )
  writeFileSync(
    path.join(stubDir, 'index.js'),
    "throw new Error('profile Stent package must not be imported')\n",
  )
  return profileDir
}

describe('stent preload injection (Stent launcher shape)', () => {
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it(
    'does not activate from STENT_CONFIG without the launcher capability',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = run(legacyConfigPath)
      expect(out.stdout).toContain(INERT_PRELOAD)
    },
  )

  it(
    'stays inert without STENT_CONFIG (host runs unmodified)',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = run()
      expect(out.stdout).toContain(INERT_PRELOAD)
    },
  )

  it(
    'prints no Stent activation marker for a direct preload',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const configured = run(legacyConfigPath)
      expect(configured.stderr).not.toContain('stent:')
      const inert = run()
      expect(inert.stderr).not.toContain('stent:')
    },
  )

  it(
    'does not resolve a profile replacement during a direct preload',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      // 写入一个会在导入时失败的 profile 替代包，验证 source launcher 不会解析到这里。
      const profileDir = createExplodingProfileStent(tempDir)
      const out = run(legacyConfigPath, profileDir)
      expect(out.stdout).toContain(INERT_PRELOAD)
    },
  )
})
