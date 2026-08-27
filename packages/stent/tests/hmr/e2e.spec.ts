/**
 * Stent HMR end-to-end proof: a real Loader tree (cordis loader, include, hmr
 * and timer plugins) with the Stent service and transformation hooks, driven
 * through both HMR surfaces a deployment can use:
 *
 * - Config-only HMR (a user patch layer observed through the HMR plugin's
 *   `registerConfig`): editing the consumer row's `disabled` flag must release
 *   and re-register the Stent patch, flipping the transformed behavior without
 *   a process restart;
 * - Module-reload HMR (the consumer plugin file inside the watch root): rewriting
 *   the plugin reloads it under the same loader entry, transferring patch
 *   ownership to the new generation.
 *
 * Each case runs in a fresh child process: the synchronous module hooks cannot
 * be unregistered and the transformed module cache must not leak between cases.
 * The runner resolves the package source relatively through tsx, so this suite
 * runs on a clean tree like the other load-time cases.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('./e2e-runner.mjs', import.meta.url))

/** Run one HMR child case and return its stdout. */
function runCase(mode: string): string {
  // tsconfig (whose paths lack these packages); children must resolve
  // against this repo's own tsconfig so source-mode imports stay on src.
  const childEnv = { ...process.env }
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', runner, mode],
    {
      cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
      encoding: 'utf8',
      env: childEnv,
      timeout: 90_000,
    },
  )
  expect(
    result.status,
    `child ${mode} exited 0\n${result.stdout}\n${result.stderr}`,
  ).toBe(0)
  return result.stdout
}

describe('stent HMR end-to-end (child processes)', () => {
  it(
    'keeps Stent transformations live through config-only HMR (row lifecycle)',
    { timeout: 120_000 },
    () => {
      const out = runCase('config')
      expect(out).toContain('PASS config v1 add(2,3): 23')
      expect(out).toContain('PASS config disabled add(2,3): 5')
      expect(out).toContain('PASS config re-enabled add(2,3): 23')
      expect(out).toContain('PASS config second disable add(2,3): 5')
      expect(out).toContain('PASS config second re-enable add(2,3): 23')
    },
  )

  it(
    'keeps Stent transformations live through module-reload HMR (plugin regeneration)',
    { timeout: 120_000 },
    () => {
      const out = runCase('module')
      expect(out).toContain('PASS module v1 add(2,3): 23')
      expect(out).toContain('PASS module reloaded add(2,3): 203')
      expect(out).toContain('PASS module reload stable add(2,3): 203')
    },
  )
})
