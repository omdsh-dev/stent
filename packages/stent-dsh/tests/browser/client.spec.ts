import { Context } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  StentClientService,
  apply,
  name,
  type StentSlotOptions,
} from '../../src/browser/client/index.ts'
import { materialize, prepareClientBundles, seedMap } from './module-loader.ts'

// ui-primitives is a heavy render-only package (markdown/highlighting);
// the command service only touches it on render paths, so stub it in the
// module table instead of pulling its dependency tree into tests.
seedMap({ '@deepseek-ai/dsh-client-ui-primitives': {} })

// The registry browser bundles ship in the dsh closure-factory format
// (window.__ModuleLoader__.load), so the real CommandUiRuntime is loaded
// through the test module loader: seed the platform table, register the
// bundle, and materialize its factory. The type arrives type-only from the
// registry package.
await prepareClientBundles(
  [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    'react',
    'react/jsx-runtime',
  ],
  [
    '@deepseek-ai/dsh-client-ui-commands/client',
    '@deepseek-ai/dsh-client-runtime/client',
  ],
)
const { CommandUiRuntime } = materialize<
  typeof import('@deepseek-ai/dsh-client-ui-commands/client')
>('@deepseek-ai/dsh-client-ui-commands')

/** Real slot/command faces; the stent client delegates through them. */
async function bench() {
  const ctx = new Context()
  const slots = new Map<
    string,
    { options: StentSlotOptions; component: unknown }
  >()
  const registrations: Array<{ disposed: boolean }> = []
  ctx.provide('inputTriggers', {
    registerSource() {
      return () => {}
    },
  })
  ctx.provide('sessions', {
    scope: () => undefined,
    scopeOf: () => undefined,
  })
  const commandsRemote = { list: () => Promise.resolve([]) }
  // CommandUiRuntime injects `remote` for the forwarded directory invalidation.
  ctx.provide('remote', { commands: commandsRemote, $on: () => () => {} })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('slots', {
    register(options: StentSlotOptions, component: unknown) {
      const record = { disposed: false }
      slots.set(options.name, { options, component })
      registrations.push(record)
      return () => {
        record.disposed = true
        slots.delete(options.name)
      }
    },
  })
  await ctx.plugin(CommandUiRuntime).await()
  await apply(ctx)
  return { ctx, slots, registrations }
}

const commandContribution = (name: string): CommandContribution => ({
  name,
  description: 'fixture command',
  available: () => true,
  ui: {
    kind: 'popupSelect',
    options: async () => [],
    onSelect: () => {},
  },
})

describe('stent-dsh browser entry', () => {
  it('exports the browser plugin faces', () => {
    expect(name).toBe('stent-dsh')
    expect(typeof apply).toBe('function')
    expect(StentClientService).toBeDefined()
  })

  it('mounts ctx.stentClient so browser Mods can register', async () => {
    const { ctx } = await bench()
    expect(ctx.get('stentClient')).toBeInstanceOf(StentClientService)
    await ctx.fiber.dispose()
  })

  it('delegates client command registration to the real command service', async () => {
    const { ctx } = await bench()
    const service = ctx.get('stentClient') as StentClientService
    const dispose = service.registerCommand(commandContribution('modfixture'))
    // The contribution reaches the authoritative client command service: a
    // duplicate registration fails loud while the first claim is live.
    expect(() =>
      service.registerCommand(commandContribution('modfixture')),
    ).toThrow()
    dispose()
    expect(() =>
      service.registerCommand(commandContribution('modfixture')),
    ).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('delegates slot registration and its disposer', async () => {
    const { ctx, slots } = await bench()
    const service = ctx.get('stentClient') as StentClientService
    const component = () => null
    const dispose = service.registerSlot({ name: 'root' }, component)
    expect(slots.get('root')?.component).toBe(component)
    dispose()
    expect(slots.has('root')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('removes a command when its contributing fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    ctx.provide('inputTriggers', {
      registerSource() {
        return () => {}
      },
    })
    ctx.provide('sessions', {
      scope: () => undefined,
      scopeOf: () => undefined,
    })
    const commandsRemote = { list: () => Promise.resolve([]) }
    // CommandUiRuntime injects `remote` for the forwarded directory invalidation.
    ctx.provide('remote', { commands: commandsRemote, $on: () => () => {} })
    ctx.provide('remote.commands', commandsRemote)
    ctx.provide('slots', {
      register() {
        return () => {}
      },
    })
    await ctx.plugin(CommandUiRuntime).await()
    await apply(ctx)
    const mod = await ctx.plugin({
      name: 'mod-client',
      inject: ['stentClient'],
      apply(modCtx: Context) {
        modCtx.stentClient.registerCommand(commandContribution('modscoped'))
      },
    })
    // The authoritative command service owns the registration as the mod
    // fiber's effect; the same name becomes available again after disposal.
    const client = ctx.get('stentClient') as StentClientService
    expect(() =>
      client.registerCommand(commandContribution('modscoped')),
    ).toThrow()
    await mod.dispose()
    expect(() =>
      client.registerCommand(commandContribution('modscoped')),
    ).not.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('stentClient keyed-slot arbitration', () => {
  const keyed = (
    priority: number,
    plugin: string,
    extra: Partial<{
      onGain: () => void
      onLost: (winner: { plugin?: string }) => void
    }> = {},
  ) => ({
    name: 'conversation.chat.toolview',
    key: 'bash',
    priority,
    plugin,
    ...extra,
  })

  it('owns by declared priority, queues the loser, and hands over on disposal', async () => {
    const { ctx, registrations } = await bench()
    const service = ctx.get('stentClient') as StentClientService
    let gained = 0
    let lost: { plugin?: string } | undefined
    const low = service.registerKeyedSlot(
      keyed(1, 'mod-low', {
        onGain: () => {
          gained++
        },
        onLost: (winner) => {
          lost = winner
        },
      }),
      () => null,
    )
    const high = service.registerKeyedSlot(keyed(2, 'mod-high'), () => null)
    // The higher-priority claimant displaced the incumbent without
    // force-disposing it: both registered, neither disposed.
    expect(low.owner).toBe(false)
    expect(high.owner).toBe(true)
    expect(lost).toEqual({ plugin: 'mod-high' })
    expect(registrations).toHaveLength(2)
    expect(registrations.every((record) => !record.disposed)).toBe(true)
    // Disposing the owner hands the key to the queued claimant, whose
    // component registers then.
    high.dispose()
    expect(low.owner).toBe(true)
    expect(gained).toBe(1)
    // The displaced incumbent's own registration is still mounted; the
    // departed owner's is gone.
    expect(registrations.filter((record) => !record.disposed)).toHaveLength(1)
    low.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps registration order on equal priorities and warns', async () => {
    const { ctx, registrations } = await bench()
    const service = ctx.get('stentClient') as StentClientService
    const first = service.registerKeyedSlot(keyed(1, 'mod-first'), () => null)
    const second = service.registerKeyedSlot(keyed(1, 'mod-second'), () => null)
    expect(first.owner).toBe(true)
    expect(second.owner).toBe(false)
    expect(registrations).toHaveLength(1)
    first.dispose()
    expect(second.owner).toBe(true)
    expect(registrations.filter((record) => !record.disposed)).toHaveLength(1)
    second.dispose()
    await ctx.fiber.dispose()
  })

  it('requires options.key', async () => {
    const { ctx } = await bench()
    const service = ctx.get('stentClient') as StentClientService
    expect(() =>
      service.registerKeyedSlot({ name: 'root' }, () => null),
    ).toThrow(/needs options.key/)
    await ctx.fiber.dispose()
  })

  it('a displaced owner may dispose itself without promoting the queue', async () => {
    const { ctx, registrations } = await bench()
    const service = ctx.get('stentClient') as StentClientService
    const incumbent = service.registerKeyedSlot(
      keyed(1, 'mod-incumbent'),
      () => null,
    )
    const challenger = service.registerKeyedSlot(
      keyed(2, 'mod-challenger'),
      () => null,
    )
    expect(incumbent.owner).toBe(false)
    // The displaced incumbent leaves on its own; the queue is untouched (the
    // challenger still owns; nobody is promoted in its place).
    incumbent.dispose()
    expect(challenger.owner).toBe(true)
    expect(registrations.filter((record) => !record.disposed)).toHaveLength(1)
    challenger.dispose()
    await ctx.fiber.dispose()
  })
})
