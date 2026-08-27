import { Context } from '@deepseek-ai/cordis'
import CommandService from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { StentAgentService } from '../../src/host/agent.ts'
import { StentCommandsService } from '../../src/host/commands.ts'
import { StentPromptService } from '../../src/host/prompt.ts'
import { StentToolsService } from '../../src/host/tools.ts'
import * as api from '../../src/index.ts'

describe('stent-dsh Host bundle', () => {
  it('mounts all four Host modules with the declared injections', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(CommandService)
    const fiber = await ctx.plugin(api)
    expect(ctx.stentAgent).toBeInstanceOf(StentAgentService)
    expect(ctx.stentTools).toBeInstanceOf(StentToolsService)
    expect(ctx.stentPrompt).toBeInstanceOf(StentPromptService)
    expect(ctx.stentCommands).toBeInstanceOf(StentCommandsService)
    await fiber.dispose()
    expect(ctx.stentAgent).toBeUndefined()
    expect(ctx.stentTools).toBeUndefined()
    expect(ctx.stentPrompt).toBeUndefined()
    expect(ctx.stentCommands).toBeUndefined()
  })
})
