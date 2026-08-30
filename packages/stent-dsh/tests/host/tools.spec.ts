import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { StentToolsService } from '../../src/host/tools.ts'

async function setup() {
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
  execute(args) {
    return Promise.resolve(args.text ?? '')
  },
})

describe('StentToolsService', () => {
  it('registers through the authoritative registry and unregisters on the disposer', async () => {
    const ctx = await setup()
    const dispose = ctx.stentTools.register(echoTool)
    expect(ctx.tools.schemas().map((t) => t.name)).toContain('mod-echo')
    dispose()
    expect(ctx.tools.schemas().map((t) => t.name)).not.toContain('mod-echo')
  })

  it('removes a registered tool when its contributing fiber disposes (HMR safety)', async () => {
    const ctx = await setup()
    const mod = await ctx.plugin({
      name: 'mod-tool',
      inject: ['stentTools'],
      apply(modCtx: Context) {
        modCtx.stentTools.register(echoTool)
      },
    })
    expect(ctx.tools.schemas().map((t) => t.name)).toContain('mod-echo')
    await mod.dispose()
    expect(ctx.tools.schemas().map((t) => t.name)).not.toContain('mod-echo')
  })

  it('inherits the authoritative registry validation', async () => {
    const ctx = await setup()
    expect(() => ctx.stentTools.register({ name: 'broken' } as never)).toThrow()
  })

  it('preserves the waterfall veto contract', async () => {
    const ctx = await setup()
    const veto = vi.fn()
    const pass = vi.fn()
    ctx.stentTools.onPreExecute(((_exec: never, _next: never) => {
      veto()
    }) as never)
    ctx.stentTools.onPreExecute((_exec, next) => {
      pass()
      return next()
    })
    const exec = { name: 'mod-echo' } as never
    const decision = await ctx.waterfall('tools/pre-execute', exec, () =>
      Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    )
    expect(veto).toHaveBeenCalledTimes(1)
    expect(pass).not.toHaveBeenCalled()
    expect(decision).toBeUndefined()
  })

  it('delegates through next() when a listener allows', async () => {
    const ctx = await setup()
    const pass = vi.fn()
    ctx.stentTools.onPreExecute((_exec, next) => {
      pass()
      return next()
    })
    const exec = { name: 'mod-echo' } as never
    const decision = await ctx.waterfall('tools/pre-execute', exec, () =>
      Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    )
    expect(pass).toHaveBeenCalledTimes(1)
    expect(decision).toEqual({ kind: 'allow' })
  })
})
