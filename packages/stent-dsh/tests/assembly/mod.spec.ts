import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { beforeEach, describe, expect, it } from 'vitest'

import * as api from '../../src/index.ts'

const fakeAgent = {} as Agent

/**
 * Boot a real Loader composition: authoritative services + the Host bundle +
 * the fixture Mod.
 */
async function assemble() {
  const ctx = new Context()
  const fixtureUrl = new URL(
    '../fixtures/node_modules/stent-api-fixture-mod/index.mjs',
    import.meta.url,
  ).href
  ctx.baseUrl = new URL('../fixtures/', import.meta.url).href
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(CommandService)
  await ctx.plugin(api)
  await ctx.plugin(Loader)
  const id = await ctx.loader.create({ name: fixtureUrl })
  await ctx.loader.await()
  return { ctx, id }
}

describe('Stent API assembled composition', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, '__stentApiFixtureSeen')
  })

  it('boots an unmodified fixture Mod and observes all four effects through the assembled app', async () => {
    const { ctx } = await assemble()

    // Tool contribution through the authoritative registry.
    expect(ctx.tools.schemas().map((t) => t.name)).toContain('mod-fixture-tool')

    // Prompt section/context/variable through the authoritative assembly.
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((s) => s.name)).toContain(
      'mod-fixture-section',
    )
    expect(assembly.contexts.map((c) => c.name)).toContain(
      'mod-fixture-context',
    )
    expect(assembly.variables['fixture_var']).toBe('fixture-value')

    // Human command through the authoritative registry.
    expect(ctx.commands.list(fakeAgent).map((c) => c.name)).toContain(
      'modfixture',
    )

    // Agent listener through the real event bus: the facade-registered
    // listener observes a dispatched status transition.
    ctx.emit('agent/status', {
      agent: { id: 'assembly-agent' } as Agent,
      status: 'running',
    })
    expect(
      (globalThis as Record<string, unknown>).__stentApiFixtureSeen,
    ).toContain('assembly-agent:running')

    await ctx.fiber.dispose()
  })

  it('removes every contribution when the Mod fiber is disposed (HMR safety)', async () => {
    const { ctx, id } = await assemble()
    expect(ctx.tools.schemas().map((t) => t.name)).toContain('mod-fixture-tool')

    await ctx.loader.remove(id)

    expect(ctx.tools.schemas().map((t) => t.name)).not.toContain(
      'mod-fixture-tool',
    )
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((s) => s.name)).not.toContain(
      'mod-fixture-section',
    )
    expect(assembly.contexts.map((c) => c.name)).not.toContain(
      'mod-fixture-context',
    )
    expect(assembly.variables['fixture_var']).toBeUndefined()
    expect(ctx.commands.list(fakeAgent).map((c) => c.name)).not.toContain(
      'modfixture',
    )
    expect(
      (globalThis as Record<string, unknown>).__stentApiFixtureSeen,
    ).toBeUndefined()

    await ctx.fiber.dispose()
  })
})
