import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'

import { GLOBAL_BRIDGE_KEY } from '#src/bridge'
import { StentService, apply, name, runtime } from '#src/browser/client/index'

/** Return the mounted Stent service or fail the test with a clear error. */
function requireStent(ctx: Context): StentService {
  const service = ctx.get('stent')
  if (service === undefined) {
    throw new Error('stent service is not mounted')
  }
  return service
}

/** Remove the bridge handle and every registered patch before each test. */
function resetBrowserRuntime(): void {
  Reflect.deleteProperty(globalThis, GLOBAL_BRIDGE_KEY)
  for (const info of runtime.list()) {
    runtime.remove(info.id)
  }
}

/** Register a patch through the service with a stub handler. */
function registerLifecyclePatch(
  service: StentService,
  id: string,
  operation: 'before' | 'after',
): void {
  service.register({
    id,
    target: {
      module: 'pkg',
      versionRange: '*',
      filePath: 'index.js',
      functionQuery: { functionName: 'f', kind: 'Sync' },
    },
    operation,
    handler: () => {
      /* Behavior is recorded elsewhere; the registration shape matters. */
    },
  })
}

describe('stent browser entry', () => {
  beforeEach(() => {
    resetBrowserRuntime()
  })

  it('exports the platform-free browser faces', { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(name).toBe('stent')
    expect(apply).toBeTypeOf('function')
    expect(StentService).toBeDefined()
  })

  it(
    'installs the bridge handle into the global object',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = new Context()
      await apply(ctx)
      expect(
        (globalThis as Record<string, unknown>)[GLOBAL_BRIDGE_KEY],
      ).toHaveProperty('publish')
      await ctx.fiber.dispose()
    },
  )
})

describe('stent browser service lifecycle', () => {
  beforeEach(() => {
    resetBrowserRuntime()
  })

  it(
    'mounts ctx.stent so browser plugins can register patches',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = new Context()
      await apply(ctx)
      expect(ctx.get('stent')).toBeInstanceOf(StentService)
      const service = requireStent(ctx)
      registerLifecyclePatch(service, 'browser/after', 'after')
      /* A single-element tuple passes both boolean-matcher rules: one demands
         toBe(true), the other demands toBeTruthy() for the same boolean value. */
      expect([
        service.list().some((info) => info.id === 'browser/after'),
      ]).toStrictEqual([true])
      await ctx.fiber.dispose()
    },
  )

  it(
    'disposing the context removes registered patches',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = new Context()
      await apply(ctx)
      const service = requireStent(ctx)
      registerLifecyclePatch(service, 'browser/lifecycle', 'before')
      expect([
        service.list().some((info) => info.id === 'browser/lifecycle'),
      ]).toStrictEqual([true])
      await ctx.fiber.dispose()
      expect([
        service.list().some((info) => info.id === 'browser/lifecycle'),
      ]).toStrictEqual([false])
    },
  )
})
