import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import { describe, expect, it } from 'vitest'

import { StentCommandsService } from '../../src/host/commands.ts'

const fakeAgent = {} as Agent

async function setup() {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  await ctx.plugin(StentCommandsService)
  return ctx
}

describe('StentCommandsService', () => {
  it('registers through the authoritative registry and unregisters on the disposer', async () => {
    const ctx = await setup()
    const dispose = ctx.stentCommands.register({
      name: 'modstatus',
      description: 'mod status',
      handler: () => ({ kind: 'success' as const, text: 'ok' }),
    })
    expect(ctx.stentCommands.list(fakeAgent).map((c) => c.name)).toContain(
      'modstatus',
    )
    dispose()
    expect(ctx.stentCommands.list(fakeAgent).map((c) => c.name)).not.toContain(
      'modstatus',
    )
  })

  it('removes a command when its contributing fiber disposes (HMR safety)', async () => {
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
    expect(ctx.stentCommands.list(fakeAgent).map((c) => c.name)).toContain(
      'modscoped',
    )
    await mod.dispose()
    expect(ctx.stentCommands.list(fakeAgent).map((c) => c.name)).not.toContain(
      'modscoped',
    )
  })

  it('inherits authoritative duplicate-name failures', async () => {
    const ctx = await setup()
    const definition = {
      name: 'dup',
      description: 'dup',
      handler: () => ({ kind: 'success' as const }),
    }
    ctx.stentCommands.register(definition)
    expect(() => ctx.stentCommands.register(definition)).toThrow(
      /already registered/,
    )
  })
})
