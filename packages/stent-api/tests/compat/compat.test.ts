import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

/** Exit status a compat child case reports when every assertion held. */
const CHILD_SUCCESS = 0

const runner = fileURLToPath(new URL('child-runner.mjs', import.meta.url))

/** Registration-only handler for patch ownership tests. */
const noop = function noop(): undefined {
  return undefined
}

/** The observation target the unit cases declare when mounting the facade. */
const GREET_TARGET = {
  name: 'greet',
  patch: {
    id: 'compat/greet-observe',
    target: {
      module: 'stent-compat-target',
      versionRange: '*',
      filePath: 'index.mjs',
      functionQuery: { functionName: 'greet', kind: 'Sync' as const },
    },
    operation: 'after' as const,
  },
}

/** A runtime patch claiming the id already claimed by {@link GREET_TARGET}. */
const GREET_PATCH = {
  id: 'compat/greet-observe',
  target: GREET_TARGET.patch.target,
  operation: 'after' as const,
  handler: noop,
}

/** The runtime patch the ownership-cycle case registers and re-registers. */
const CYCLE_PATCH = {
  id: 'compat/cycle',
  target: {
    module: 'm',
    versionRange: '*',
    filePath: 'f.js',
    functionQuery: { functionName: 'g', kind: 'Sync' as const },
  },
  operation: 'after' as const,
  handler: noop,
}

/** Run one compat child case and return its stdout. */
function runCase(name: string): string {
  /* The child resolves the package dependency from the API package's own
     workspace manifest after its build prerequisite has completed. */
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', runner, name],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
    },
  )
  expect(
    result.status,
    `child ${name} exited 0\n${result.stdout}\n${result.stderr}`,
  ).toBe(CHILD_SUCCESS)
  return result.stdout
}

/** Mount a Cordis context carrying the low-level Stent registry. */
async function mountStent(): Promise<Context> {
  const { Context: CordisContext } = await import('@deepseek-ai/cordis')
  const { StentService, markStentDshLaunch } = await import('@oh-my-dsh/stent')
  markStentDshLaunch()
  const ctx = new CordisContext()
  await ctx.plugin(StentService)
  return ctx
}

describe('stentCompatService observation (child processes)', () => {
  it(
    'observes a patch-backed target and stops on disposer',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = runCase('observe')
      expect(out).toContain('PASS observe results: "hello world,hello stent"')
      expect(out).toContain('PASS observe seen: "hello world|hello stent"')
      expect(out).toContain('PASS observe after dispose: 2')
    },
  )

  it('fails loud when the bridge is not installed', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const out = runCase('noBridge')
    expect(out).toContain('PASS noBridge throws: true')
  })

  it('fails loud on an unknown target name', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const out = runCase('unknownTarget')
    expect(out).toContain('PASS unknown target throws: true')
  })
})

describe('stentCompatService runtime patches (child processes)', () => {
  it(
    'registers a runtime patch that rewrites the target',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = runCase('registerPatch')
      expect(out).toContain(
        'PASS registerPatch returns id: "compat/greet-upper"',
      )
      expect(out).toContain('PASS registerPatch rewrites: "HELLO WORLD"')
    },
  )

  it(
    'keeps the id namespace exclusive and re-registers after unregister',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = runCase('registerPatch')
      expect(out).toContain(
        'PASS registerPatch target-id conflict throws: true',
      )
      expect(out).toContain('PASS registerPatch self conflict throws: true')
      expect(out).toContain(
        'PASS unregister delegates to original: "hello world"',
      )
      expect(out).toContain(
        'PASS re-register after unregister rewrites: "HELLO WORLD"',
      )
    },
  )
})

describe('stentCompatService hot reload (child processes)', () => {
  it(
    "a single-plugin hot reload keeps the new generation's hook after the old generation unloads",
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = runCase('hmr')
      expect(out).toContain('PASS hmr gen1 rewrites: "HELLO WORLD"')
      expect(out).toContain('PASS hmr gen2 rewrites: "HELLO STENT"')
      expect(out).toContain('PASS hmr gen2 survives gen1 unload: "HELLO AFTER"')
      expect(out).toContain(
        'PASS hmr gen2 unload restores original: "hello again"',
      )
    },
  )

  it(
    're-applying the facade plugin leaves the new generation fully functional',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = runCase('compatHmr')
      expect(out).toContain('PASS compatHmr gen1 rewrites: "HELLO WORLD"')
      expect(out).toContain(
        'PASS compatHmr gen1 unload restores original: "hello world"',
      )
      expect(out).toContain('PASS compatHmr gen2 rewrites: "HELLO STENT"')
      expect(out).toContain(
        'PASS compatHmr gen2 observed: "hello world|hello stent"',
      )
      expect(out).toContain(
        'PASS compatHmr gen2 unload restores original: "hello again"',
      )
    },
  )
})

describe('stentCompatService cross-plugin claims (child process)', () => {
  it(
    'rejects the same patch id claimed by a different plugin',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = runCase('sameId')
      expect(out).toContain('PASS sameId cross-plugin claim throws: true')
      expect(out).toContain('PASS sameId incumbent still hooks: "HELLO WORLD"')
      expect(out).toContain(
        'PASS sameId incumbent unload restores original: "hello world"',
      )
    },
  )
})

describe('stentCompatService (unit)', () => {
  it(
    'rejects a patch id already claimed by a declared observation target, even without a bridge',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      /* The conflict check runs before the bridge check, so a claimed id fails
       loud in any process; the bridge check only guards actual registration. */
      const ctx = await mountStent()
      const { StentCompatService } = await import('#src/compat/service')
      await ctx.plugin(StentCompatService, { targets: [GREET_TARGET] })
      expect(() => ctx.stentCompat.registerPatch(GREET_PATCH)).toThrow(
        /already claimed/u,
      )
      await ctx.fiber.dispose()
    },
  )

  it(
    'unregisterPatch removes the entry so a re-registration starts a fresh ownership cycle',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await mountStent()
      const { StentCompatService } = await import('#src/compat/service')
      await ctx.plugin(StentCompatService, {})
      ctx.stentCompat.registerPatch(CYCLE_PATCH)
      ctx.stentCompat.unregisterPatch('compat/cycle')
      /* Unregistering removed the entry and freed the id: a re-registration
       starts fresh instead of inheriting the first registration's disposal. */
      expect(() => ctx.stentCompat.registerPatch(CYCLE_PATCH)).not.toThrow()
      await ctx.fiber.dispose()
    },
  )
})
