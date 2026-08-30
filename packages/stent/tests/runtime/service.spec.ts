import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  getStent,
  installBridge,
  isStentInstalled,
  markStentDshLaunch,
  runtime,
  StentService,
} from '../../src/index.ts'

describe('StentService launch gating', () => {
  it('keeps Stent-dependent plugins pending before the stent-dsh launch marker', async () => {
    installBridge()
    expect(isStentInstalled()).toBe(true)
    const ctx = new Context()
    await ctx.plugin(StentService)
    let applied = false
    const fiber = ctx.plugin({
      name: 'stent-gated-fixture',
      inject: ['stent'],
      apply: () => {
        applied = true
      },
    })
    await Promise.resolve()
    expect(applied).toBe(false)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails loudly when a plugin omits inject and calls getStent before the stent-dsh launch marker', async () => {
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
    ).rejects.toThrow(/getStent\(ctx\) requires the stent-dsh launch path/)
    expect(applied).toBe(true)
    expect(ctx.get('stent')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('activates Stent-dependent plugins after the stent-dsh launch marker', async () => {
    markStentDshLaunch()
    const ctx = new Context()
    await ctx.plugin(StentService)
    let applied = false
    await ctx.plugin({
      name: 'stent-gated-fixture',
      inject: ['stent'],
      apply: () => {
        applied = true
      },
    })
    expect(applied).toBe(true)
    await ctx.fiber.dispose()
  })
})

describe('StentService registration', () => {
  it('registers a patch tied to the fiber effect', () => {
    const ctx = new Context()
    const service = new StentService(ctx)
    expect(service).toBeInstanceOf(StentService)
    const id = service.register({
      id: 'service/a',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'after',
      handler: () => {},
    })
    expect(id).toBe('service/a')
    expect(service.list().some((info) => info.id === id)).toBe(true)
  })

  it('is reachable as ctx.stent when mounted as a plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(StentService)
    expect(ctx.stent).toBeInstanceOf(StentService)
    ctx.stent.register({
      id: 'service/b',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'g', kind: 'Sync' as const },
      },
      operation: 'before',
      handler: () => {},
    })
    expect(ctx.stent.list().some((info) => info.id === 'service/b')).toBe(true)
  })

  it('rejects invalid patches with descriptive errors', () => {
    const ctx = new Context()
    const service = new StentService(ctx)
    expect(() =>
      service.register({
        id: 'x',
        target: { module: '', versionRange: '*', filePath: 'f.js' },
        operation: 'before',
        handler: () => {},
      }),
    ).toThrow(/module/)
    expect(() =>
      service.register({
        id: 'x',
        target: { module: 'm', versionRange: '*', filePath: 'f.js' },
        operation: 'sideways' as never,
        handler: () => {},
      }),
    ).toThrow(/operation/)
    expect(() =>
      service.register({
        id: 'x',
        target: { module: 'm', versionRange: '*', filePath: 'f.js' },
        operation: 'before',
        handler: undefined as never,
      }),
    ).toThrow(/handler/)
    expect(() =>
      service.register({
        id: 'x',
        target: { module: 'm', versionRange: '*', filePath: 'f.js' },
        operation: 'before',
        handler: () => {},
      }),
    ).toThrow(/functionQuery or astQuery/)
    expect(() =>
      service.register({
        id: 'x',
        target: {
          module: 'm',
          versionRange: '*',
          filePath: 'f.js',
          astQuery: '   ',
        },
        operation: 'before',
        handler: () => {},
      }),
    ).toThrow(/astQuery must not be blank/)
  })

  it('bindings() snapshots one patch or every recorded binding', () => {
    const ctx = new Context()
    const service = new StentService(ctx)
    runtime.recordBindings('service/one', [
      { module: 'm', file: 'f.js', nodes: 1 },
    ])
    expect(service.bindings('service/one')).toHaveLength(1)
    expect(service.bindings('service/none')).toEqual([])
    expect(service.bindings().some((record) => record.file === 'f.js')).toBe(
      true,
    )
  })
})

describe('StentService mounting', () => {
  it('getStent mounts once and reuses the mounted service', () => {
    markStentDshLaunch()
    const ctx = new Context()
    const first = getStent(ctx)
    expect(first).toBeInstanceOf(StentService)
    expect(ctx.get('stent')).toBeInstanceOf(StentService)
    expect(() => getStent(ctx)).not.toThrow()
    expect(getStent(ctx)).toBeInstanceOf(StentService)
  })

  it('getStent returns an already-mounted service untouched', async () => {
    markStentDshLaunch()
    const ctx = new Context()
    await ctx.plugin(StentService)
    expect(getStent(ctx)).toBeInstanceOf(StentService)
    expect(ctx.get('stent')).toBeInstanceOf(StentService)
  })
})

describe('StentService HMR ownership', () => {
  it('a same-plugin re-registration takes over; the stale disposer does not unregister it', async () => {
    markStentDshLaunch()
    const ctx = new Context()
    const patch = {
      id: 'service/hmr',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'after' as const,
      handler: () => {},
    }
    const host = (app: Context) => {
      getStent(app).register(patch)
    }
    const gen1 = await ctx.plugin(host)
    const gen2 = await ctx.plugin(host)
    expect(runtime.isEnabled('service/hmr')).toBe(true)
    await gen1.dispose()
    expect(runtime.isEnabled('service/hmr')).toBe(true)
    await gen2.dispose()
    expect(runtime.isEnabled('service/hmr')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('rejects the same patch id from a different plugin', async () => {
    markStentDshLaunch()
    const ctx = new Context()
    const patch = {
      id: 'service/x',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'after' as const,
      handler: () => {},
    }
    const pluginA = (app: Context) => {
      getStent(app).register(patch)
    }
    const pluginB = (app: Context) => {
      getStent(app).register({ ...patch, handler: () => {} })
    }
    const fiberA = await ctx.plugin(pluginA)
    let threw = ''
    try {
      await ctx.plugin(pluginB)
    } catch (error) {
      if (error instanceof Error) {
        threw = error.message
      } else {
        threw = String(error)
      }
    }
    expect(threw).toMatch(/already registered by another owner/)
    expect(runtime.isEnabled('service/x')).toBe(true)
    await fiberA.dispose()
    expect(runtime.isEnabled('service/x')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('resolves the registration owner from the loader entry when present', async () => {
    markStentDshLaunch()
    const ctx = new Context()
    const patch = {
      id: 'service/entry-owned',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'after' as const,
      handler: () => {},
    }
    const plugin = (app: Context) => {
      ;(app.fiber as { entry?: unknown }).entry = { id: 'web-config-crawler' }
      getStent(app).register(patch)
    }
    const fiber = await ctx.plugin(plugin)
    expect(runtime.isEnabled('service/entry-owned')).toBe(true)
    await fiber.dispose()
    expect(runtime.isEnabled('service/entry-owned')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('remove() frees the entry and owns() reflects the owning fiber', async () => {
    markStentDshLaunch()
    const ctx = new Context()
    const patch = {
      id: 'service/removable',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'after' as const,
      handler: () => {},
    }
    const plugin = (app: Context) => {
      getStent(app).register(patch)
    }
    const fiber = await ctx.plugin(plugin)
    const service = ctx.get('stent') as StentService
    const owner = (fiber as { ctx: Context }).ctx.fiber
    expect(service.owns('service/removable', owner)).toBe(true)
    service.remove('service/removable')
    expect(service.owns('service/removable', owner)).toBe(false)
    expect(runtime.isEnabled('service/removable')).toBe(false)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
