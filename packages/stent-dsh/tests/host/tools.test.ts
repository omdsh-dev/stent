import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecution,
} from '@deepseek-ai/dsh-tools'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { StentToolsService } from '#src/host/tools'

/** The published `tools/pre-execute` waterfall listener contract. */
type PreExecuteListener = (
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>

/**
 * Mount the authoritative tool registry and the facade under test.
 *
 * @returns The context owning both services.
 */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(StentToolsService)
  return ctx
}

const echoTool = defineTool({
  name: 'mod-echo',
  description: 'echo arguments back',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    await Promise.resolve()
    return args.text ?? ''
  },
})

/**
 * @param ctx - The context whose registry is queried.
 * @returns The registered tool names visible to the model.
 */
function toolNames(ctx: Context): string[] {
  const schemas = ctx.tools.schemas()
  const names = schemas.map((schema) => schema.name)
  return names
}

/**
 * Stand in for the registry's own terminal step of the waterfall.
 *
 * @returns The decision a delegating listener finally observes.
 */
async function allowDecision(): Promise<PreToolDecision> {
  await Promise.resolve()
  const decision: PreToolDecision = { kind: 'allow' }
  return decision
}

/**
 * Build the pending call the specs dispatch through the waterfall.
 *
 * @returns An execution stand-in carrying only the dispatched tool name.
 */
function fakeExecution(): ToolExecution {
  const executionShape = { name: 'mod-echo' }
  // @ts-expect-error -- Deliberate stand-in: only the dispatched tool name is read on this path.
  const stub: ToolExecution = executionShape
  return stub
}

/**
 * Build the documented veto: a listener that returns without delegating.
 *
 * @param veto - Called when the listener runs.
 * @returns The vetoing listener.
 */
function vetoing(veto: () => void): PreExecuteListener {
  // @ts-expect-error -- The documented veto returns without delegating, which the published signature cannot express.
  const listener: PreExecuteListener = (): void => {
    veto()
  }
  return listener
}

/**
 * Build a listener that delegates to the next step of the waterfall.
 *
 * @param pass - Called when the listener runs.
 * @returns The delegating listener.
 */
function delegating(pass: () => void): PreExecuteListener {
  return async (_exec, delegate) => {
    pass()
    const decision = await delegate()
    return decision
  }
}

describe('stent tool api registration', () => {
  it(
    'registers through the authoritative registry and unregisters on the disposer',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const dispose = ctx.stentTools.register(echoTool)
      expect(toolNames(ctx)).toContain('mod-echo')
      dispose()
      expect(toolNames(ctx)).not.toContain('mod-echo')
    },
  )

  it(
    'removes a registered tool when its contributing fiber disposes (HMR safety)',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const mod = await ctx.plugin({
        name: 'mod-tool',
        inject: ['stentTools'],
        apply(modCtx: Context) {
          modCtx.stentTools.register(echoTool)
        },
      })
      expect(toolNames(ctx)).toContain('mod-echo')
      await mod.dispose()
      expect(toolNames(ctx)).not.toContain('mod-echo')
    },
  )

  it(
    'inherits the authoritative registry validation',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      // @ts-expect-error -- Deliberate invalid definition: the registry must reject a missing output contract.
      const broken: ToolDefinition = { name: 'broken' }
      expect(() => ctx.stentTools.register(broken)).toThrow(
        /must declare output/u,
      )
    },
  )
})

describe('stent tool api pre-execute waterfall', () => {
  it('preserves the waterfall veto contract', { timeout: 5000 }, async () => {
    expect.hasAssertions()
    const ctx = await setup()
    const veto = vi.fn<() => void>()
    const pass = vi.fn<() => void>()
    ctx.stentTools.onPreExecute(vetoing(veto))
    ctx.stentTools.onPreExecute(delegating(pass))
    const decision = await ctx.waterfall(
      'tools/pre-execute',
      fakeExecution(),
      allowDecision,
    )
    expect(veto).toHaveBeenCalledExactlyOnceWith()
    expect(pass).not.toHaveBeenCalled()
    expect(decision).toBeUndefined()
  })

  it(
    'delegates through next() when a listener allows',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = await setup()
      const pass = vi.fn<() => void>()
      ctx.stentTools.onPreExecute(delegating(pass))
      const decision = await ctx.waterfall(
        'tools/pre-execute',
        fakeExecution(),
        allowDecision,
      )
      expect(pass).toHaveBeenCalledExactlyOnceWith()
      expect(decision).toStrictEqual({ kind: 'allow' })
    },
  )
})
