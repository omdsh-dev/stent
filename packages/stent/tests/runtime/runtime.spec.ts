import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { publish, subscribeBridge } from '../../src/bridge.ts'
import {
  runtime,
  validatePatchId,
  validatePatchStatic,
  StentService,
  getStent,
  STENT_DSH_LAUNCH_KEY,
  markStentDshLaunch,
  GLOBAL_BRIDGE_KEY,
  installBridge,
  isStentInstalled,
} from '../../src/index.ts'

const baseInfo = (id: string, enabled = false) => ({
  id,
  target: { module: 'pkg', versionRange: '*', filePath: 'index.js' },
  operation: 'before' as const,
  priority: 0,
  enabled,
})

describe('stent runtime registry', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, STENT_DSH_LAUNCH_KEY)
    Reflect.deleteProperty(globalThis, GLOBAL_BRIDGE_KEY)
    for (const info of runtime.list()) {
      runtime.remove(info.id)
    }
  })

  it('registers, enables, disables, and removes patches', () => {
    expect(runtime.register(baseInfo('a'))).toBe(true)
    expect(runtime.isEnabled('a')).toBe(false)
    const handler = () => {}
    runtime.enable('a', handler)
    expect(runtime.isEnabled('a')).toBe(true)
    runtime.disable('a')
    expect(runtime.isEnabled('a')).toBe(false)
    runtime.remove('a')
    expect(runtime.isEnabled('a')).toBe(false)
    expect(runtime.list()).toHaveLength(0)
  })

  it('notifies loader subscribers when static metadata changes', () => {
    const changes: string[] = []
    const unsubscribe = runtime.onPatchChange((change) =>
      changes.push(`${change.type}:${change.id}`),
    )
    runtime.register(baseInfo('watch/a'))
    runtime.register({ ...baseInfo('watch/a'), operation: 'after' })
    runtime.remove('watch/a')
    unsubscribe()
    expect(changes).toEqual([
      'register:watch/a',
      'register:watch/a',
      'remove:watch/a',
    ])
  })

  it('re-registering an id keeps metadata but reports not-first', () => {
    runtime.register(baseInfo('a'))
    expect(runtime.register(baseInfo('a'))).toBe(false)
  })

  it('rejects an id registered by a different owner', () => {
    runtime.register({ ...baseInfo('own/a') }, 'owner-a')
    // A patch id is exclusive to one plugin; a different owner's claim fails
    // loud where the entry would otherwise be silently shared.
    expect(() => {
      runtime.register({ ...baseInfo('own/a') }, 'owner-b')
    }).toThrow(/already registered by another owner/)
    // The same owner may re-register: an HMR generation takes its patch back.
    expect(runtime.register({ ...baseInfo('own/a') }, 'owner-a')).toBe(false)
  })

  it('same-owner re-registration transfers fiber ownership', () => {
    runtime.register({ ...baseInfo('own/b') }, 'owner', 'fiber-1')
    expect(runtime.isOwnedBy('own/b', 'fiber-1')).toBe(true)
    expect(runtime.isOwnedBy('own/b', 'fiber-2')).toBe(false)
    expect(runtime.register({ ...baseInfo('own/b') }, 'owner', 'fiber-2')).toBe(
      false,
    )
    // The previous fiber's disposer must no longer own the entry...
    expect(runtime.isOwnedBy('own/b', 'fiber-1')).toBe(false)
    expect(runtime.isOwnedBy('own/b', 'fiber-2')).toBe(true)
    // ...and removal clears the ownership for every fiber.
    runtime.remove('own/b')
    expect(runtime.isOwnedBy('own/b', 'fiber-2')).toBe(false)
  })

  it('list() orders by priority then id and reflects enabled state', () => {
    runtime.register({ ...baseInfo('b', false), priority: 2 })
    runtime.register({ ...baseInfo('a', false), priority: 1 })
    runtime.register({ ...baseInfo('c', false), priority: 1 })
    runtime.enable('c', () => {})
    const ids = runtime.list().map((info) => info.id)
    expect(ids).toEqual(['a', 'c', 'b'])
    expect(runtime.list().find((info) => info.id === 'c')?.enabled).toBe(true)
  })

  it('enable on an unregistered id throws', () => {
    expect(() => {
      runtime.enable('nope', () => {})
    }).toThrow(/unregistered/)
  })

  it('enable with a non-function handler fails loud instead of crashing in dispatch', () => {
    runtime.register(baseInfo('a'))
    expect(() => {
      runtime.enable('a', 42 as never)
    }).toThrow(/must be a function/)
    expect(runtime.isEnabled('a')).toBe(false)
  })

  it('validatePatchId rejects unsafe ids and accepts safe ones', () => {
    for (const bad of [
      '',
      'has space',
      '汉字',
      'a'.repeat(121),
      'semi;colon',
    ]) {
      expect(() => {
        validatePatchId(bad)
      }).toThrow(/patch id/)
    }
    expect(() => {
      validatePatchId('vendor/pkg:patch-name_1.2')
    }).not.toThrow()
  })

  it('rejects a second replace patch on the same target', () => {
    const target = {
      module: 'pkg',
      versionRange: '*',
      filePath: 'index.js',
      functionQuery: { functionName: 'run', kind: 'Sync' as const },
    }
    runtime.register({
      id: 'r1',
      target,
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
    expect(() => {
      runtime.register({
        id: 'r2',
        target,
        operation: 'replace',
        priority: 0,
        enabled: false,
      })
    }).toThrow(/conflicts with existing replace patch "r1"/)
    // Re-registering the same id is not a conflict, and a non-replace patch on
    // the same target is allowed (stacking semantics).
    expect(
      runtime.register({
        id: 'r1',
        target,
        operation: 'replace',
        priority: 0,
        enabled: false,
      }),
    ).toBe(false)
    runtime.register({
      id: 'b1',
      target,
      operation: 'before',
      priority: 0,
      enabled: false,
    })
  })

  it('re-registering into an already-claimed replace target still fails', () => {
    const target = {
      module: 'pkg',
      versionRange: '*',
      filePath: 'index.js',
      functionQuery: { functionName: 'run', kind: 'Sync' as const },
    }
    // A patch first registered as `before` must not bypass the exclusive
    // replace scan by re-registering the same id as `replace`.
    runtime.register({
      id: 'x1',
      target,
      operation: 'before',
      priority: 0,
      enabled: false,
    })
    runtime.register({
      id: 'z1',
      target,
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
    expect(() => {
      runtime.register({
        id: 'x1',
        target,
        operation: 'replace',
        priority: 0,
        enabled: false,
      })
    }).toThrow(/conflicts with existing replace patch "z1"/)
  })

  it('allows replace patches on different targets', () => {
    runtime.register({
      id: 'x1',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'a.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
    runtime.register({
      id: 'x2',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'b.js',
        functionQuery: { functionName: 'g', kind: 'Sync' as const },
      },
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
  })

  it('records load-time bindings per patch and merges them into list()', () => {
    runtime.recordBindings('bind/a', [
      { module: 'pkg', file: 'index.js', nodes: 2 },
    ])
    runtime.recordBindings('bind/a', [
      { module: 'pkg', file: 'lib.js', nodes: 1 },
    ])
    runtime.recordBindings('bind/b', [
      { module: 'other', file: 'run.js', nodes: 1 },
    ])
    expect(runtime.bindingsOf('bind/a')).toEqual([
      { module: 'pkg', file: 'index.js', nodes: 2 },
      { module: 'pkg', file: 'lib.js', nodes: 1 },
    ])
    expect(runtime.bindingsOf('bind/nope')).toEqual([])
    // allBindings flattens in patch-id order.
    expect(runtime.allBindings().map((record) => record.file)).toEqual([
      'index.js',
      'lib.js',
      'run.js',
    ])
    // list() entries carry the recorded bindings regardless of registration.
    runtime.register({
      id: 'bind/a',
      target: { module: 'pkg', versionRange: '*', filePath: 'index.js' },
      operation: 'before',
      priority: 0,
      enabled: false,
    })
    expect(
      runtime.list().find((info) => info.id === 'bind/a')?.bindings,
    ).toHaveLength(2)
  })

  it('validatePatchStatic rejects a non-boolean required flag', () => {
    const target = { module: 'pkg', versionRange: '*', filePath: 'index.js' }
    expect(() => {
      validatePatchStatic({
        target,
        operation: 'before',
        required: 'yes' as never,
      })
    }).toThrow(/required must be a boolean/)
    expect(() => {
      validatePatchStatic({ target, operation: 'before', required: true })
    }).not.toThrow()
  })

  it('validatePatchStatic accepts filePaths and rejects invalid combinations', () => {
    const base = { module: 'pkg', versionRange: '*' }
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePaths: ['a.js', 'b.js'] },
        operation: 'before',
      })
    }).not.toThrow()
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePath: 'a.js' },
        operation: 'before',
      })
    }).not.toThrow()
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePath: 'a.js', filePaths: ['b.js'] },
        operation: 'before',
      })
    }).toThrow(/not both/)
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePaths: [] },
        operation: 'before',
      })
    }).toThrow(/filePaths/)
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePaths: [''] },
        operation: 'before',
      })
    }).toThrow(/filePaths/)
    expect(() => {
      validatePatchStatic({ target: { ...base }, operation: 'before' })
    }).toThrow(/filePath or filePaths/)
  })
})

describe('StentService', () => {
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

  it('getStent mounts once and reuses the mounted service', () => {
    markStentDshLaunch()
    const ctx = new Context()
    const first = getStent(ctx)
    expect(first).toBeInstanceOf(StentService)
    expect(ctx.get('stent')).toBeInstanceOf(StentService)
    // Cordis rejects a second registration of the same service, so the
    // accessor returning at all proves it reused the mounted registry.
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
    const host = async (app: Context) => {
      getStent(app).register(patch)
    }
    // Generation 2 of the same plugin (the same callback, re-applied)
    // registers while generation 1 still owns the patch — the overlapping
    // window of a hot reload.
    const gen1 = await ctx.plugin(host)
    const gen2 = await ctx.plugin(host)
    expect(runtime.isEnabled('service/hmr')).toBe(true)
    // Generation 1's cleanup must not unregister generation 2's hook.
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
    const pluginA = async (app: Context) => {
      getStent(app).register(patch)
    }
    const pluginB = async (app: Context) => {
      getStent(app).register({ ...patch, handler: () => {} })
    }
    const fiberA = await ctx.plugin(pluginA)
    let threw = ''
    try {
      await ctx.plugin(pluginB)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    expect(threw).toMatch(/already registered by another owner/)
    // Plugin A's registration is untouched by the rejected claim.
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
    // The Loader stamps `fiber.entry` (the composition row) before apply
    // runs; it is the stable identity across that row's HMR generations.
    const plugin = async (app: Context) => {
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
    const plugin = async (app: Context) => {
      getStent(app).register(patch)
    }
    const fiber = await ctx.plugin(plugin)
    const service = ctx.get('stent') as StentService
    // The plugin call returns a wrapper; the ownership token is the real
    // fiber behind the wrapper's context.
    const owner = (fiber as { ctx: Context }).ctx.fiber
    expect(service.owns('service/removable', owner)).toBe(true)
    service.remove('service/removable')
    expect(service.owns('service/removable', owner)).toBe(false)
    expect(runtime.isEnabled('service/removable')).toBe(false)
    // The registering fiber's disposal no-ops on the already-removed entry.
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('bridge multi-listener dispatch', () => {
  const disposers: Array<() => void> = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose()
    }
  })

  const call = (id: string) => ({
    id,
    operation: 'before' as const,
    arguments: [1],
    self: undefined,
    traced: () => 'traced',
  })

  it('runs every listener in registration order and returns the last result', () => {
    const seen: string[] = []
    disposers.push(
      subscribeBridge(() => {
        seen.push('first')
        return 'first-result'
      }),
    )
    disposers.push(
      subscribeBridge(() => {
        seen.push('second')
        return 'second-result'
      }),
    )
    expect(publish(call('bridge/multi'))).toBe('second-result')
    expect(seen).toEqual(['first', 'second'])
  })

  it('disposed listeners stop receiving calls; the traced fallback takes over', () => {
    const dispose = subscribeBridge(() => 'handled')
    dispose()
    expect(publish(call('bridge/none'))).toBe('traced')
  })
})
