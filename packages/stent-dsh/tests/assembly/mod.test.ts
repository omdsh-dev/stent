import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { apply, inject, name } from '#src/index'

/**
 * Global marker the fixture Mod writes when its agent listener observes a
 * transition.
 */
const FIXTURE_SEEN_KEY = '__stentApiFixtureSeen'

const fixtureUrl = new URL(
  '../fixtures/node_modules/stent-api-fixture-mod/index.mjs',
  import.meta.url,
).href
const fixtureBaseUrl = new URL('../fixtures/', import.meta.url).href

/** Narrow the stand-in to the minimum Agent shape used by the assembly APIs. */
function isAgent(value: unknown): value is Agent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as { readonly id?: unknown }
  return typeof record.id === 'string'
}

/** Build the record-shaped stand-in and vouch for the Agent face. */
function ensureAgent(record: unknown): Agent {
  if (!isAgent(record)) {
    throw new Error('test fixture: agent record must be an object')
  }
  return record
}

/** Test-side agent stand-in: only the id is observed by the fixture listener. */
const fakeAgent = ensureAgent({ id: 'assembly-agent' })

/** Read the fixture's array-shaped marker from the shared test global. */
function fixtureSeen(): unknown[] | undefined {
  const globalRecord = globalThis as Record<PropertyKey, unknown>
  const marker = globalRecord[FIXTURE_SEEN_KEY]
  if (!Array.isArray(marker)) {
    return undefined
  }
  return marker as unknown[]
}

/**
 * Collect registry entry names; keeps third-party element types out of
 * callbacks.
 */
function names(entries: readonly { readonly name: string }[]): string[] {
  const result: string[] = []
  for (const entry of entries) {
    result.push(entry.name)
  }
  return result
}

/** Mount the authoritative services, the Host bundle, and the Loader. */
async function bootContext(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = fixtureBaseUrl
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(CommandService)
  await ctx.plugin({ name, inject, apply })
  await ctx.plugin(Loader)
  return ctx
}

/** Boot the real Loader composition around the fixture Mod. */
async function assemble(): Promise<{ ctx: Context; id: string }> {
  const ctx = await bootContext()
  const id = await ctx.loader.create({ name: fixtureUrl })
  await ctx.loader.await()
  return { ctx, id }
}

describe('stent API assembled composition', () => {
  beforeAll(() => {
    Reflect.deleteProperty(globalThis, FIXTURE_SEEN_KEY)
  })

  it(
    'boots an unmodified fixture Mod and exposes its tool and prompt contributions',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx } = await assemble()

      // Tool contribution through the authoritative registry.
      expect(names(ctx.tools.schemas())).toContain('mod-fixture-tool')

      // Prompt section/context/variable through the authoritative assembly.
      const assembly = await ctx.systemPrompt.assemble()
      expect(names(assembly.sections)).toContain('mod-fixture-section')
      expect(names(assembly.contexts)).toContain('mod-fixture-context')
      expect(assembly.variables.fixture_var).toBe('fixture-value')

      await ctx.fiber.dispose()
    },
  )

  it(
    'forwards the fixture command and observes the agent listener through the event bus',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx } = await assemble()

      // Human command through the authoritative registry.
      expect(names(ctx.commands.list(fakeAgent))).toContain('modfixture')

      /* Agent listener through the real event bus: the facade-registered
         listener observes a dispatched status transition. */
      ctx.emit('agent/status', { agent: fakeAgent, status: 'running' })
      expect(fixtureSeen()).toContain('assembly-agent:running')

      await ctx.fiber.dispose()
    },
  )
})

describe('stent API assembled composition: disposal (HMR safety)', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, FIXTURE_SEEN_KEY)
  })

  it(
    'removes tool and prompt contributions when the Mod fiber is disposed',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx, id } = await assemble()
      expect(names(ctx.tools.schemas())).toContain('mod-fixture-tool')

      await ctx.loader.remove(id)

      expect(names(ctx.tools.schemas())).not.toContain('mod-fixture-tool')
      const assembly = await ctx.systemPrompt.assemble()
      expect(names(assembly.sections)).not.toContain('mod-fixture-section')
      expect(names(assembly.contexts)).not.toContain('mod-fixture-context')
      expect(assembly.variables.fixture_var).toBeUndefined()

      await ctx.fiber.dispose()
    },
  )

  it(
    'removes the command and the agent observation when the Mod fiber is disposed',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx, id } = await assemble()
      await ctx.loader.remove(id)

      expect(names(ctx.commands.list(fakeAgent))).not.toContain('modfixture')
      expect(fixtureSeen()).toBeUndefined()

      await ctx.fiber.dispose()
    },
  )
})
