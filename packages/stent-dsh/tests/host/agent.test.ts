import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'

import { StentAgentService } from '#src/host/agent'

/**
 * Build a live-agent stand-in around one injection spy.
 *
 * @param inject - The spy standing in for the agent's own injection path.
 * @returns The stand-in accepted by the facade and its events.
 */
function fakeAgent(inject = vi.fn<Agent['inject']>()): Agent {
  const agentShape = { inject }
  // @ts-expect-error -- Deliberate stand-in: the facade only forwards the agent and calls `inject()` on it.
  const stub: Agent = agentShape
  return stub
}

/**
 * Mount the facade under test.
 *
 * @returns The context owning the service.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(StentAgentService)
  return ctx
}

/**
 * Collect every agent the facade reports through its creation observers.
 *
 * @param ctx - The context whose facade is observed.
 * @returns The created and disposed agents, in observation order.
 */
function observeLifecycle(ctx: Context): {
  created: Agent[]
  disposed: Agent[]
} {
  const created: Agent[] = []
  const disposed: Agent[] = []
  ctx.stentAgent.onCreated((observed) => {
    created.push(observed)
  })
  ctx.stentAgent.onDisposed((observed) => {
    disposed.push(observed)
  })
  return { created, disposed }
}

const message = createUserMessage({
  content: [{ type: 'text', text: 'hi' }],
  source: { kind: 'user' },
})

describe('stent agent api observation', () => {
  it(
    'forwards lifecycle events and removes a listener on its disposer',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const seen: AgentStatus[] = []
      const dispose = ctx.stentAgent.onStatus((_agent, status) => {
        seen.push(status)
      })
      ctx.emit('agent/status', { agent: fakeAgent(), status: 'running' })
      expect(seen).toStrictEqual(['running'])
      dispose()
      ctx.emit('agent/status', { agent: fakeAgent(), status: 'idle' })
      expect(seen).toStrictEqual(['running'])
    },
  )

  it(
    'forwards created and disposed observations',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const { created, disposed } = observeLifecycle(ctx)
      const agent = fakeAgent()
      ctx.emit('agent/created', { agent })
      ctx.emit('agent/disposed', { agent })
      expect(created).toStrictEqual([agent])
      expect(disposed).toStrictEqual([agent])
    },
  )
})

describe('stent agent api scope and injection', () => {
  it(
    'removes a listener when its contributing fiber disposes (HMR safety)',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const seen: AgentStatus[] = []
      const mod = await ctx.plugin({
        name: 'mod-observer',
        inject: ['stentAgent'],
        apply(modCtx: Context) {
          modCtx.stentAgent.onStatus((_agent, status) => {
            seen.push(status)
          })
        },
      })
      ctx.emit('agent/status', { agent: fakeAgent(), status: 'running' })
      await mod.dispose()
      ctx.emit('agent/status', { agent: fakeAgent(), status: 'idle' })
      expect(seen).toStrictEqual(['running'])
    },
  )

  it(
    "injects through the agent's own logged path",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const inject = vi.fn<Agent['inject']>()
      const agent = fakeAgent(inject)
      ctx.stentAgent.inject(agent, message)
      expect(inject).toHaveBeenCalledExactlyOnceWith(message)
    },
  )
})
