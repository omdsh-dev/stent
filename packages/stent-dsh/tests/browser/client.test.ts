// @vitest-environment happy-dom

import { Context } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import { describe, expect, it } from 'vitest'

import { StentClientService, apply, name } from '#src/browser/client/index'

import type { CommandUiModule } from './module-loader.ts'
import {
  isCommandUiModule,
  materializeAs,
  prepareClientBundles,
  seedMap,
} from './module-loader.ts'

/* Arbitration fixtures: the declared priorities, the registration counts the fake slot host must show, and the errors the host services raise. */
const LOW_PRIORITY = 1
const HIGH_PRIORITY = 2
const BOTH_REGISTERED = 2
const ONE_REGISTERED = 1
const DUPLICATE_FIXTURE = /duplicate contribution for \/modfixture/u
const DUPLICATE_SCOPED = /duplicate contribution for \/modscoped/u
const NEEDS_KEY = /needs options\.key/u

/** The slot-registration fields the fake host and the fixtures rely on. */
interface SlotOptions {
  readonly name: string
}
/** A keyed claim declaration with its arbitration fields. */
interface KeyedOptions extends SlotOptions {
  readonly key: string
  readonly priority: number
  readonly plugin: string
}
/** The claim handle `registerKeyedSlot` hands back. */
type Claim = ReturnType<StentClientService['registerKeyedSlot']>
/** One registration the fake slot host accepted, and its disposal state. */
interface SlotRecord {
  readonly options: SlotOptions
  readonly component: unknown
  disposed: boolean
}
/** The wiring one test operates on. */
interface Bench {
  readonly ctx: Context
  readonly service: StentClientService
  readonly slots: Map<string, SlotRecord>
  readonly registrations: SlotRecord[]
}
/** A bench whose keyed slot is contested by a low- and a high-priority claim. */
interface Contested extends Bench {
  readonly low: Claim
  readonly high: Claim
  readonly gains: string[]
  readonly losses: { plugin?: string }[]
}

/* The registry browser bundles ship in the dsh closure-factory format
   (window.__ModuleLoader__.load), so the real CommandUiRuntime is loaded through
   the test module loader. ui-primitives is a heavy render-only package the
   command service only touches on render paths, so it is stubbed in the table
   instead of pulling its dependency tree into the tests. */
async function loadCommandUi(): Promise<CommandUiModule> {
  seedMap({ '@deepseek-ai/dsh-client-ui-primitives': {} })
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
  return materializeAs('@deepseek-ai/dsh-client-ui-commands', isCommandUiModule)
}

const { CommandUiRuntime } = await loadCommandUi()

/** Stand-in for the fake disposers and for the registered slot components. */
const noop = function noop(): undefined {
  return undefined
}
/** The forwarded command directory and the fixture command are both empty. */
async function noEntries(): Promise<never[]> {
  const entries: never[] = []
  /* Yield once so the fake honours the asynchronous host contract. */
  await Promise.resolve()
  return entries
}
/** The unkeyed slot the delegation tests contribute to. */
const root: SlotOptions = { name: 'root' }
/** One client command contribution fixture. */
const commandContribution = (commandName: string): CommandContribution => ({
  name: commandName,
  description: 'fixture command',
  available: (): boolean => true,
  ui: { kind: 'popupSelect', options: noEntries, onSelect: noop },
})
/** A claim on one shared keyed slot, declared at the given priority. */
const keyed = (priority: number, plugin: string): KeyedOptions => ({
  name: 'conversation.chat.toolview',
  key: 'bash',
  priority,
  plugin,
})
/** How many of the fake host's registrations are still mounted. */
const liveCount = (registrations: readonly SlotRecord[]): number => {
  const active = registrations.filter((record) => !record.disposed)
  return active.length
}

/* CommandUiRuntime injects the '/' source registry, the session scopes and
   `remote`, which forwards the command directory invalidation; the fake slot
   host records every registration it accepts and its disposal. */
function provideFakes(ctx: Context): Pick<Bench, 'slots' | 'registrations'> {
  const commands = { list: noEntries }
  const slots = new Map<string, SlotRecord>()
  const registrations: SlotRecord[] = []
  ctx.provide('inputTriggers', { registerSource: (): (() => void) => noop })
  ctx.provide('sessions', { scope: noop, scopeOf: noop })
  ctx.provide('remote', { commands, $on: (): (() => void) => noop })
  ctx.provide('remote.commands', commands)
  ctx.provide('slots', {
    register(options: SlotOptions, component: unknown): () => void {
      const record: SlotRecord = { options, component, disposed: false }
      slots.set(options.name, record)
      registrations.push(record)
      return (): void => {
        record.disposed = true
        slots.delete(options.name)
      }
    },
  })
  return { slots, registrations }
}

/** Real slot/command faces; the stent client delegates through them. */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  const { slots, registrations } = provideFakes(ctx)
  await ctx.plugin(CommandUiRuntime).await()
  await apply(ctx)
  const service = ctx.get('stentClient')
  if (service === undefined) {
    throw new Error('stent-dsh test: browser client service not mounted')
  }
  return { ctx, service, slots, registrations }
}

/** The low-priority incumbent claims the key first, the challenger second. */
async function contested(): Promise<Contested> {
  const seat = await bench()
  const gains: string[] = []
  const losses: { plugin?: string }[] = []
  const low = seat.service.registerKeyedSlot(
    {
      ...keyed(LOW_PRIORITY, 'mod-low'),
      onGain: (): void => {
        gains.push('mod-low')
      },
      onLost: (winner): void => {
        losses.push(winner)
      },
    },
    noop,
  )
  const challenger = keyed(HIGH_PRIORITY, 'mod-high')
  const high = seat.service.registerKeyedSlot(challenger, noop)
  return { ...seat, low, high, gains, losses }
}

describe('stent-dsh browser entry', () => {
  it('exports the browser plugin faces', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    expect(name).toBe('stent-dsh')
    expect(apply).toBeTypeOf('function')
    expect(StentClientService).toBeDefined()
  })

  it('mounts ctx.stentClient for Mods', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx } = await bench()
    expect(ctx.get('stentClient')).toBeInstanceOf(StentClientService)
    await ctx.fiber.dispose()
  })
})

describe('stentClient command delegation', () => {
  it('delegates command registration', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, service } = await bench()
    const fixture = commandContribution('modfixture')
    const dispose = service.registerCommand(fixture)
    /* The contribution reaches the authoritative client command service: a
       duplicate registration fails loud while the first claim is live. */
    expect(() => service.registerCommand(fixture)).toThrow(DUPLICATE_FIXTURE)
    dispose()
    expect(() => service.registerCommand(fixture)).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('drops a mod command with its fiber', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, service } = await bench()
    const scoped = commandContribution('modscoped')
    const mod = await ctx.plugin({
      name: 'mod-client',
      inject: ['stentClient'],
      apply(modCtx: Context): void {
        modCtx.stentClient.registerCommand(scoped)
      },
    })
    /* HMR safety: the authoritative command service owns the registration as
       the mod fiber's effect, so the name frees up when that fiber disposes. */
    expect(() => service.registerCommand(scoped)).toThrow(DUPLICATE_SCOPED)
    await mod.dispose()
    expect(() => service.registerCommand(scoped)).not.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('stentClient slot delegation', () => {
  it('delegates slot registration', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, service, slots } = await bench()
    const dispose = service.registerSlot(root, noop)
    expect(slots.get('root')?.component).toBe(noop)
    dispose()
    // Tuple compare: the two boolean-matcher rules reject each other's form.
    expect([slots.has('root')]).toStrictEqual([false])
    await ctx.fiber.dispose()
  })

  it('requires options.key', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, service } = await bench()
    expect(() => service.registerKeyedSlot(root, noop)).toThrow(NEEDS_KEY)
    await ctx.fiber.dispose()
  })
})

describe('stentClient keyed-slot arbitration', () => {
  it('owns the key by declared priority', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, registrations, low, high, losses } = await contested()
    /* The higher-priority claimant displaced the incumbent without
       force-disposing it: both registered, neither disposed. */
    expect([low.owner, high.owner]).toStrictEqual([false, true])
    expect(losses).toStrictEqual([{ plugin: 'mod-high' }])
    expect(registrations).toHaveLength(BOTH_REGISTERED)
    expect(liveCount(registrations)).toBe(BOTH_REGISTERED)
    await ctx.fiber.dispose()
  })

  it('hands the key over on disposal', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, registrations, low, high, gains } = await contested()
    /* Disposing the owner hands the key to the queued claimant, whose
       component registers then; the departed owner's registration is gone. */
    high.dispose()
    expect([low.owner]).toStrictEqual([true])
    expect(gains).toStrictEqual(['mod-low'])
    expect(liveCount(registrations)).toBe(ONE_REGISTERED)
    low.dispose()
    await ctx.fiber.dispose()
  })
})

describe('stentClient keyed-slot queue', () => {
  it('lets a displaced owner leave quietly', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, registrations, low, high } = await contested()
    /* The displaced incumbent leaves on its own: the challenger still owns the
       key and nobody is promoted in its place. */
    expect([low.owner]).toStrictEqual([false])
    low.dispose()
    expect([high.owner]).toStrictEqual([true])
    expect(liveCount(registrations)).toBe(ONE_REGISTERED)
    await ctx.fiber.dispose()
  })

  it('keeps order on equal priorities', { timeout: 30_000 }, async () => {
    expect.hasAssertions()
    const { ctx, registrations, service } = await bench()
    /* Equal priorities keep registration order (and log a warning naming both
       plugins); the runner-up takes over when the owner leaves. */
    const first = service.registerKeyedSlot(keyed(LOW_PRIORITY, 'first'), noop)
    const second = service.registerKeyedSlot(keyed(LOW_PRIORITY, 'later'), noop)
    expect([first.owner, second.owner]).toStrictEqual([true, false])
    expect(registrations).toHaveLength(ONE_REGISTERED)
    first.dispose()
    expect([second.owner]).toStrictEqual([true])
    expect(liveCount(registrations)).toBe(ONE_REGISTERED)
    await ctx.fiber.dispose()
  })
})
