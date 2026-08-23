import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('./child-runner.mjs', import.meta.url))

/** Run one compat child case and return its stdout. */
function runCase(name: string): string {
  // tsconfig (whose paths lack these packages); children must resolve
  // against this repo's own tsconfig so source-mode imports stay on src.
  const childEnv = { ...process.env }
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', runner, name], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    encoding: 'utf8',
    env: childEnv,
  })
  expect(result.status, `child ${name} exited 0\n${result.stdout}\n${result.stderr}`).toBe(0)
  return result.stdout
}

describe('StentCompatService (child processes)', () => {
  it('observes a patch-backed target and stops on disposer', () => {
    const out = runCase('observe')
    expect(out).toContain('PASS observe results: "hello world,hello stent"')
    expect(out).toContain('PASS observe seen: "hello world|hello stent"')
    expect(out).toContain('PASS observe after dispose: 2')
  })

  it('fails loud when the bridge is not installed', () => {
    const out = runCase('noBridge')
    expect(out).toContain('PASS noBridge throws: true')
  })

  it('fails loud on an unknown target name', () => {
    const out = runCase('unknownTarget')
    expect(out).toContain('PASS unknown target throws: true')
  })

  it('registers runtime patches with an exclusive id namespace', () => {
    const out = runCase('registerPatch')
    expect(out).toContain('PASS registerPatch returns id: "compat/greet-upper"')
    expect(out).toContain('PASS registerPatch rewrites: "HELLO WORLD"')
    expect(out).toContain('PASS registerPatch target-id conflict throws: true')
    expect(out).toContain('PASS registerPatch self conflict throws: true')
    expect(out).toContain('PASS unregister delegates to original: "hello world"')
    expect(out).toContain('PASS re-register after unregister rewrites: "HELLO WORLD"')
  })

  it('a single-plugin hot reload keeps the new generation\'s hook after the old generation unloads', () => {
    const out = runCase('hmr')
    expect(out).toContain('PASS hmr gen1 rewrites: "HELLO WORLD"')
    expect(out).toContain('PASS hmr gen2 rewrites: "HELLO STENT"')
    expect(out).toContain('PASS hmr gen2 survives gen1 unload: "HELLO AFTER"')
    expect(out).toContain('PASS hmr gen2 unload restores original: "hello again"')
  })

  it('re-applying the facade plugin leaves the new generation fully functional', () => {
    const out = runCase('compatHmr')
    expect(out).toContain('PASS compatHmr gen1 rewrites: "HELLO WORLD"')
    expect(out).toContain('PASS compatHmr gen1 unload restores original: "hello world"')
    expect(out).toContain('PASS compatHmr gen2 rewrites: "HELLO STENT"')
    expect(out).toContain('PASS compatHmr gen2 observed: "hello world|hello stent"')
    expect(out).toContain('PASS compatHmr gen2 unload restores original: "hello again"')
  })

  it('rejects the same patch id claimed by a different plugin', () => {
    const out = runCase('sameId')
    expect(out).toContain('PASS sameId cross-plugin claim throws: true')
    expect(out).toContain('PASS sameId incumbent still hooks: "HELLO WORLD"')
    expect(out).toContain('PASS sameId incumbent unload restores original: "hello world"')
  })
})

describe('StentCompatService (unit)', () => {
  it('rejects a patch id already claimed by a declared observation target, even without a bridge', async () => {
    // The conflict check runs before the bridge check, so a claimed id fails
    // loud in any process; the bridge check only guards actual registration.
    const { Context } = await import('@deepseek-ai/cordis')
    const { StentService, markStentDshLaunch } = await import('@oh-my-dsh/stent')
    const { StentCompatService } = await import('../../src/compat/service.ts')
    markStentDshLaunch()
    const ctx = new Context()
    await ctx.plugin(StentService)
    await ctx.plugin(StentCompatService, {
      targets: [{
        name: 'greet',
        patch: { id: 'compat/greet-observe', target: { module: 'stent-compat-target', versionRange: '*', filePath: 'index.mjs' }, operation: 'after' },
      }],
    })
    expect(() => {
      ctx.stentCompat.registerPatch({
        id: 'compat/greet-observe',
        target: { module: 'stent-compat-target', versionRange: '*', filePath: 'index.mjs' },
        operation: 'after',
        handler: () => {},
      })
    }).toThrow(/already claimed/)
    await ctx.fiber.dispose()
  })

  it('unregisterPatch removes the entry so a re-registration starts a fresh ownership cycle', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { StentService, markStentDshLaunch } = await import('@oh-my-dsh/stent')
    const { StentCompatService } = await import('../../src/compat/service.ts')
    markStentDshLaunch()
    const ctx = new Context()
    await ctx.plugin(StentService)
    await ctx.plugin(StentCompatService, {})
    const patch = {
      id: 'compat/cycle',
      target: { module: 'm', versionRange: '*', filePath: 'f.js', functionQuery: { functionName: 'g', kind: 'Sync' as const } },
      operation: 'after' as const,
      handler: () => {},
    }
    ctx.stentCompat.registerPatch(patch)
    ctx.stentCompat.unregisterPatch('compat/cycle')
    // Unregistering removed the entry and freed the id: a re-registration
    // starts fresh instead of inheriting the first registration's disposal.
    expect(() => ctx.stentCompat.registerPatch({ ...patch, handler: () => {} })).not.toThrow()
    await ctx.fiber.dispose()
  })
})
