import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, beforeEach } from 'vitest'
import { GLOBAL_BRIDGE_KEY } from '../../src/bridge.ts'
import { StentService, apply, name, runtime } from '../../src/browser/client/index.ts'

describe('stent browser entry', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, GLOBAL_BRIDGE_KEY)
    for (const info of runtime.list()) runtime.remove(info.id)
  })

  it('exports the platform-free browser faces', () => {
    expect(name).toBe('stent')
    expect(typeof apply).toBe('function')
    expect(StentService).toBeDefined()
  })

  it('installs the bridge handle into the global object', async () => {
    const ctx = new Context()
    await apply(ctx)
    expect((globalThis as Record<string, unknown>)[GLOBAL_BRIDGE_KEY]).toHaveProperty('publish')
    await ctx.fiber.dispose()
  })

  it('mounts ctx.stent so browser plugins can register patches', async () => {
    const ctx = new Context()
    await apply(ctx)
    expect(ctx.get('stent')).toBeInstanceOf(StentService)
    const service = ctx.get('stent') as StentService
    service.register({
      id: 'browser/after',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'f', kind: 'Sync' },
      },
      operation: 'after',
      handler: () => {},
    })
    expect(service.list().some(info => info.id === 'browser/after')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('disposing the context removes registered patches', async () => {
    const ctx = new Context()
    await apply(ctx)
    const service = ctx.get('stent') as StentService
    service.register({
      id: 'browser/lifecycle',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'index.js',
        functionQuery: { functionName: 'g', kind: 'Sync' },
      },
      operation: 'before',
      handler: () => {},
    })
    expect(service.list().some(info => info.id === 'browser/lifecycle')).toBe(true)
    await ctx.fiber.dispose()
    expect(service.list().some(info => info.id === 'browser/lifecycle')).toBe(false)
  })
})
