/**
 * Stent async `module.register` fallback proof: the async hook path is driven
 * in a child process against the BUILT loader, so this suite only runs once
 * `pnpm run build` has produced the loader-thread hook entry.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** Child exit status for a completed run. */
const EXIT_SUCCESS = 0

const runner = fileURLToPath(new URL('async-fallback.mjs', import.meta.url))
const hookEntry = fileURLToPath(
  new URL('../../lib/node/hook-entry.js', import.meta.url),
)

/**
 * Every line the runner prints when the async hook path transforms both module
 * systems.
 */
const EXPECTED_LINES = [
  'PASS async-fallback add(2,3): 23',
  'PASS async-fallback dynamic greet(world): "hello world!"',
  'PASS async-fallback cjs add(2,3): 23',
  'PASS async-fallback reloaded add(2,3): 203',
  'PASS async-fallback stacked greet(world): "hello worldAB"',
]

/* The async path resolves the loader-thread hook entry next to the BUILT
   loader, so this suite requires `pnpm run build` to have run. */
describe.skipIf(!existsSync(hookEntry))(
  'stent async module.register fallback (built lib)',
  () => {
    it(
      'transforms ESM and CommonJS targets on the async hook path',
      { timeout: 60_000 },
      () => {
        expect.hasAssertions()
        /* Tsconfig (whose paths lack these packages); the child must resolve
           against this repo's own tsconfig so source-mode imports stay on src. */
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          STENT_FORCE_ASYNC_HOOKS: '1',
        }
        const result = spawnSync(process.execPath, [runner], {
          cwd: fileURLToPath(new URL('../../..', import.meta.url)),
          encoding: 'utf8',
          env: childEnv,
        })
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          EXIT_SUCCESS,
        )
        for (const line of EXPECTED_LINES) {
          expect(result.stdout).toContain(line)
        }
      },
    )
  },
)
