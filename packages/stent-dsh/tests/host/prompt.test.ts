import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'

import { StentPromptService } from '#src/host/prompt'

/**
 * Mount the authoritative system-prompt registry and the facade under test.
 *
 * @returns The context owning both services.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(StentPromptService)
  return ctx
}

/**
 * @param ctx - The context whose assembly is inspected.
 * @returns The assembled section names, in assembly order.
 */
async function sectionNames(ctx: Context): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble()
  const { sections } = assembly
  return sections.map((section) => section.name)
}

/**
 * @param ctx - The context whose assembly is inspected.
 * @returns The assembled dynamic-context names, in assembly order.
 */
async function contextNames(ctx: Context): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble()
  const { contexts } = assembly
  return contexts.map((contribution) => contribution.name)
}

describe('stent prompt api', () => {
  it(
    'registers sections and variables through the authoritative registry',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      ctx.stentPrompt.section({
        name: 'mod-identity',
        order: -50,
        text: 'identity: {{mod_name}}',
      })
      ctx.stentPrompt.variable('mod_name', () => 'stent-demo')
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map((section) => section.name)).toContain(
        'mod-identity',
      )
      expect(assembly.variables.mod_name).toBe('stent-demo')
    },
  )

  it('removes a section on its disposer', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    const ctx = await setup()
    const dispose = ctx.stentPrompt.section({
      name: 'mod-ephemeral',
      order: 0,
      text: 'gone soon',
    })
    await expect(sectionNames(ctx)).resolves.toContain('mod-ephemeral')
    dispose()
    await expect(sectionNames(ctx)).resolves.not.toContain('mod-ephemeral')
  })
})

describe('stent prompt api scope and validation', () => {
  it(
    'removes contributions when the contributing fiber disposes (HMR safety)',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
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
      await expect(sectionNames(ctx)).resolves.toContain('mod-scoped')
      await expect(contextNames(ctx)).resolves.toContain('mod-cache')
      await mod.dispose()
      await expect(sectionNames(ctx)).resolves.not.toContain('mod-scoped')
      await expect(contextNames(ctx)).resolves.not.toContain('mod-cache')
    },
  )

  it(
    'inherits authoritative duplicate-name and invalid-name failures',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      ctx.stentPrompt.section({ name: 'dup', order: 0, text: 'first' })
      expect(() =>
        ctx.stentPrompt.section({ name: 'dup', order: 1, text: 'second' }),
      ).toThrow(/already registered/u)
      expect(() => ctx.stentPrompt.variable('UPPER', () => 'x')).toThrow(
        /invalid prompt variable name/u,
      )
    },
  )
})
