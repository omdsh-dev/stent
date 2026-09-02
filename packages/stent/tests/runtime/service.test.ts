import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  StentService,
  getStent,
  installBridge,
  isStentInstalled,
  markStentDshLaunch,
  runtime,
} from '#src/index'

/** Registration-only handler; no transformed call reaches these patches. */
const handler = function handler(): void {
  /* Nothing to dispatch: these tests only exercise registration bookkeeping. */
  return undefined
}

/** Fixture patch; every registration test derives its own id from this one. */
const basePatch = {
  id: 'service/base',
  target: {
    module: 'pkg',
    versionRange: '*',
    filePath: 'index.js',
    functionQuery: { functionName: 'f', kind: 'Sync' },
  },
  operation: 'after',
  handler,
} as const

/** Fixture patch for the validation cases: a target carrying no query. */
const barePatch = {
  id: 'x',
  target: { module: 'm', versionRange: '*', filePath: 'f.js' },
  operation: 'before',
  handler,
} as const

/** The single load-time binding record the bindings snapshot test records. */
const binding = { module: 'm', file: 'f.js', nodes: 1 }

/** Plugin body registering the fixture patch for `id` through `getStent`. */
const registrar =
  (id: string): ((app: Context) => void) =>
  (app) => {
    getStent(app).register({ ...basePatch, id })
  }

/** A fresh context created after the stent-dsh launch marker is set. */
const launched = (): Context => {
  markStentDshLaunch()
  return new Context()
}

/** A fresh context with the Stent service mounted as a plugin. */
const mounted = async (): Promise<Context> => {
  const ctx = new Context()
  await ctx.plugin(StentService)
  return ctx
}

/** The plugin fiber `ctx.plugin()` returns for one mounted generation. */
type Generation = Context['fiber']

/** Dispose one plugin generation, then report whether `id` stays enabled. */
const disposeThen = async (fiber: Generation, id: string): Promise<boolean> => {
  await fiber.dispose()
  return runtime.isEnabled(id)
}

describe('stentService launch gating', () => {
  it('keeps gated plugins pending pre-launch', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    installBridge()
    expect({ installed: isStentInstalled() }).toStrictEqual({ installed: true })
    const ctx = await mounted()
    let applied = false
    const fiber = ctx.plugin({
      name: 'stent-gated-fixture',
      inject: ['stent'],
      apply: () => {
        applied = true
      },
    })
    await Promise.resolve()
    expect({ applied }).toStrictEqual({ applied: false })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails loudly on ungated getStent', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    installBridge()
    const ctx = new Context()
    let applied = false
    await expect(
      ctx.plugin({
        name: 'legacy-stent-fixture',
        apply: (app: Context) => {
          applied = true
          getStent(app)
        },
      }),
    ).rejects.toThrow(/getStent\(ctx\) requires the stent-dsh launch path/u)
    expect({ applied }).toStrictEqual({ applied: true })
    expect(ctx.get('stent')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('stentService launch activation', () => {
  it('activates gated plugins after launch', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    markStentDshLaunch()
    const ctx = await mounted()
    let applied = false
    await ctx.plugin({
      name: 'stent-gated-fixture',
      inject: ['stent'],
      apply: () => {
        applied = true
      },
    })
    expect({ applied }).toStrictEqual({ applied: true })
    await ctx.fiber.dispose()
  })
})

describe('stentService registration', () => {
  it('registers a patch on the fiber effect', { timeout: 5000 }, () => {
    expect.hasAssertions()
    const service = new StentService(new Context())
    expect(service).toBeInstanceOf(StentService)
    const id = service.register({ ...basePatch, id: 'service/a' })
    expect(id).toBe('service/a')
    expect(service.list().map((info) => info.id)).toContain(id)
  })

  it('is reachable as ctx.stent when mounted', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    const ctx = await mounted()
    expect(ctx.stent).toBeInstanceOf(StentService)
    ctx.stent.register({ ...basePatch, id: 'service/b', operation: 'before' })
    expect(ctx.stent.list().map((info) => info.id)).toContain('service/b')
  })

  it('snapshots one patch or every binding', { timeout: 5000 }, () => {
    expect.hasAssertions()
    const service = new StentService(new Context())
    runtime.recordBindings('service/one', [binding])
    expect(service.bindings('service/one')).toStrictEqual([binding])
    expect(service.bindings('service/none')).toStrictEqual([])
    expect(service.bindings().map((record) => record.file)).toContain('f.js')
  })
})

describe('stentService patch validation', () => {
  it(
    'rejects invalid patches with descriptive errors',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const service = new StentService(new Context())
      expect(() =>
        service.register({
          ...barePatch,
          target: { ...barePatch.target, module: '' },
        }),
      ).toThrow(/module/u)
      expect(() =>
        service.register({
          ...barePatch,
          // @ts-expect-error -- A deliberately invalid operation kind.
          operation: 'sideways',
        }),
      ).toThrow(/operation/u)
      expect(() =>
        service.register({
          ...barePatch,
          // @ts-expect-error -- A deliberately missing handler.
          handler: undefined,
        }),
      ).toThrow(/handler/u)
      expect(() => service.register(barePatch)).toThrow(
        /functionQuery or astQuery/u,
      )
      expect(() =>
        service.register({
          ...barePatch,
          target: { ...barePatch.target, astQuery: '   ' },
        }),
      ).toThrow(/astQuery must not be blank/u)
    },
  )
})

describe('stentService mounting', () => {
  it('mounts once and reuses the service', { timeout: 5000 }, () => {
    expect.hasAssertions()
    const ctx = launched()
    expect(getStent(ctx)).toBeInstanceOf(StentService)
    expect(ctx.get('stent')).toBeInstanceOf(StentService)
    expect(() => getStent(ctx)).not.toThrow()
    expect(getStent(ctx)).toBeInstanceOf(StentService)
  })

  it('returns an already-mounted service', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    markStentDshLaunch()
    const ctx = await mounted()
    expect(getStent(ctx)).toBeInstanceOf(StentService)
    expect(ctx.get('stent')).toBeInstanceOf(StentService)
  })
})

describe('stentService HMR ownership', () => {
  it(
    'a same-plugin re-registration takes over; the stale disposer does not unregister it',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = launched()
      const host = registrar('service/hmr')
      const [stale, current] = [await ctx.plugin(host), await ctx.plugin(host)]
      const states = [
        runtime.isEnabled('service/hmr'),
        await disposeThen(stale, 'service/hmr'),
        await disposeThen(current, 'service/hmr'),
      ]
      expect(states).toStrictEqual([true, true, false])
      await ctx.fiber.dispose()
    },
  )

  it('rejects a patch id from another plugin', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    const ctx = launched()
    const owner = await ctx.plugin(registrar('service/x'))
    await expect(ctx.plugin(registrar('service/x'))).rejects.toThrow(
      /already registered by another owner/u,
    )
    const states = [
      runtime.isEnabled('service/x'),
      await disposeThen(owner, 'service/x'),
    ]
    expect(states).toStrictEqual([true, false])
    await ctx.fiber.dispose()
  })
})

describe('stentService fiber ownership', () => {
  it('resolves the owner from a loader entry', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    const ctx = launched()
    const fiber = await ctx.plugin((app: Context) => {
      Object.assign(app.fiber, { entry: { id: 'web-config-crawler' } })
      getStent(app).register({ ...basePatch, id: 'service/entry-owned' })
    })
    const states = [
      runtime.isEnabled('service/entry-owned'),
      await disposeThen(fiber, 'service/entry-owned'),
    ]
    expect(states).toStrictEqual([true, false])
    await ctx.fiber.dispose()
  })

  it(
    'remove() frees the entry and owns() reflects the owning fiber',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = launched()
      const fiber = await ctx.plugin(registrar('service/removable'))
      const service = getStent(ctx)
      const owner = fiber.ctx.fiber
      const owned = [service.owns('service/removable', owner)]
      service.remove('service/removable')
      owned.push(
        service.owns('service/removable', owner),
        runtime.isEnabled('service/removable'),
      )
      expect(owned).toStrictEqual([true, false, false])
      await ctx.fiber.dispose()
    },
  )
})
