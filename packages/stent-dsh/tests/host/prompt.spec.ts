import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'

import { StentPromptService } from '../../src/host/prompt.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(StentPromptService)
  return ctx
}

describe('StentPromptService', () => {
  it('registers sections and variables through the authoritative registry', async () => {
    const ctx = await setup()
    ctx.stentPrompt.section({
      name: 'mod-identity',
      order: -50,
      text: 'identity: {{mod_name}}',
    })
    ctx.stentPrompt.variable('mod_name', () => 'stent-demo')
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((s) => s.name)).toContain('mod-identity')
    expect(assembly.variables['mod_name']).toBe('stent-demo')
  })

  it('removes a section on its disposer', async () => {
    const ctx = await setup()
    const dispose = ctx.stentPrompt.section({
      name: 'mod-ephemeral',
      order: 0,
      text: 'gone soon',
    })
    expect(
      (await ctx.systemPrompt.assemble()).sections.map((s) => s.name),
    ).toContain('mod-ephemeral')
    dispose()
    expect(
      (await ctx.systemPrompt.assemble()).sections.map((s) => s.name),
    ).not.toContain('mod-ephemeral')
  })

  it('removes contributions when the contributing fiber disposes (HMR safety)', async () => {
    const ctx = await setup()
    const mod = await ctx.plugin({
      name: 'mod-prompt',
      inject: ['stentPrompt'],
      apply(modCtx: Context) {
        modCtx.stentPrompt.section({
          name: 'mod-scoped',
          order: 10,
          text: 'scoped',
        })
        modCtx.stentPrompt.context({
          name: 'mod-cache',
          order: 1,
          text: 'cached',
        })
      },
    })
    const before = await ctx.systemPrompt.assemble()
    expect(before.sections.map((s) => s.name)).toContain('mod-scoped')
    expect(before.contexts.map((c) => c.name)).toContain('mod-cache')
    await mod.dispose()
    const after = await ctx.systemPrompt.assemble()
    expect(after.sections.map((s) => s.name)).not.toContain('mod-scoped')
    expect(after.contexts.map((c) => c.name)).not.toContain('mod-cache')
  })

  it('inherits authoritative duplicate-name and invalid-name failures', async () => {
    const ctx = await setup()
    ctx.stentPrompt.section({ name: 'dup', order: 0, text: 'first' })
    expect(() =>
      ctx.stentPrompt.section({ name: 'dup', order: 1, text: 'second' }),
    ).toThrow(/already registered/)
    expect(() => ctx.stentPrompt.variable('UPPER', () => 'x')).toThrow(
      /invalid prompt variable name/,
    )
  })
})
