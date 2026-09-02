import { Context } from '@deepseek-ai/cordis'
import CommandService from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { StentAgentService } from '#src/host/agent'
import { StentCommandsService } from '#src/host/commands'
import { StentPromptService } from '#src/host/prompt'
import { StentToolsService } from '#src/host/tools'
import { apply, inject, name } from '#src/index'

/** Mount the four Host modules over the authoritative services. */
async function mountHostBundle(): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(CommandService)
  const fiber = await ctx.plugin({ name, inject, apply })
  return { ctx, fiber }
}

describe('stent-dsh Host bundle', () => {
  it(
    'mounts all four Host modules with the declared injections',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx, fiber } = await mountHostBundle()

      expect(ctx.stentAgent).toBeInstanceOf(StentAgentService)
      expect(ctx.stentTools).toBeInstanceOf(StentToolsService)
      expect(ctx.stentPrompt).toBeInstanceOf(StentPromptService)
      expect(ctx.stentCommands).toBeInstanceOf(StentCommandsService)

      await fiber.dispose()
    },
  )

  it(
    'removes every Host module when the fiber disposes',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx, fiber } = await mountHostBundle()
      await fiber.dispose()

      expect(ctx.stentAgent).toBeUndefined()
      expect(ctx.stentTools).toBeUndefined()
      expect(ctx.stentPrompt).toBeUndefined()
      expect(ctx.stentCommands).toBeUndefined()
    },
  )
})
