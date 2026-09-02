import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import { describe, expect, it } from 'vitest'

import { StentCommandsService } from '#src/host/commands'

// @ts-expect-error -- Deliberate stand-in: `list()` uses the agent only as a scoped-layer key, so no member of it is ever read.
const agent: Agent = {}

/**
 * Mount the authoritative command registry and the facade under test.
 *
 * @returns The context owning both services.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  await ctx.plugin(StentCommandsService)
  return ctx
}

/**
 * @param ctx - The context whose facade is queried.
 * @returns The effective command names for the stand-in agent.
 */
function commandNames(ctx: Context): string[] {
  const descriptors = ctx.stentCommands.list(agent)
  const names = descriptors.map((descriptor) => descriptor.name)
  return names
}

/**
 * Register the command name the duplicate-name spec registers twice.
 *
 * @param ctx - The context registering the definition.
 * @returns The exact disposer returned by the authoritative registry.
 */
function registerDup(ctx: Context): () => void {
  return ctx.stentCommands.register({
    name: 'dup',
    description: 'dup',
    handler: () => ({ kind: 'success' as const }),
  })
}

describe('stent command api', () => {
  it(
    'registers through the authoritative registry and unregisters on the disposer',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const dispose = ctx.stentCommands.register({
        name: 'modstatus',
        description: 'mod status',
        handler: () => ({ kind: 'success' as const, text: 'ok' }),
      })
      expect(commandNames(ctx)).toContain('modstatus')
      dispose()
      expect(commandNames(ctx)).not.toContain('modstatus')
    },
  )

  it(
    'inherits authoritative duplicate-name failures',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      registerDup(ctx)
      expect(() => registerDup(ctx)).toThrow(/already registered/u)
    },
  )
})

describe('stent command api fiber scope', () => {
  it(
    'removes a command when its contributing fiber disposes (HMR safety)',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const mod = await ctx.plugin({
        name: 'mod-command',
        inject: ['stentCommands'],
        apply(modCtx: Context) {
          modCtx.stentCommands.register({
            name: 'modscoped',
            description: 'mod scoped',
            handler: () => ({ kind: 'success' as const }),
          })
        },
      })
      expect(commandNames(ctx)).toContain('modscoped')
      await mod.dispose()
      expect(commandNames(ctx)).not.toContain('modscoped')
    },
  )
})
