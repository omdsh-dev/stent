import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('./async-fallback.mjs', import.meta.url))
const hookEntry = fileURLToPath(new URL('../../lib/node/hook-entry.js', import.meta.url))

// The async path resolves the loader-thread hook entry next to the BUILT
// loader, so this suite requires `pnpm run build` to have run.
describe.skipIf(!existsSync(hookEntry))('stent async module.register fallback (built lib)', () => {
  it('transforms ESM and CommonJS targets on the async hook path', () => {
    // tsconfig; the child must resolve against this repo's own tsconfig.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, STENT_FORCE_ASYNC_HOOKS: '1' }
    const result = spawnSync(process.execPath, [runner], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      encoding: 'utf8',
      env: childEnv,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PASS async-fallback add(2,3): 23')
    expect(result.stdout).toContain('PASS async-fallback dynamic greet(world): "hello world!"')
    expect(result.stdout).toContain('PASS async-fallback cjs add(2,3): 23')
    expect(result.stdout).toContain('PASS async-fallback reloaded add(2,3): 203')
    expect(result.stdout).toContain('PASS async-fallback stacked greet(world): "hello worldAB"')
  })
})
