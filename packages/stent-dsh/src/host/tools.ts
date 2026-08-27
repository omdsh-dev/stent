/**
 * The Stent Tool API module: a stable, Mod-facing surface for registering tools
 * and pre/post execution listeners over the authoritative tool registry.
 *
 * The facade delegates every call to `ctx.tools` and `ctx.on()`: policy,
 * approval, timeout, logging, cancellation, rendering, and the authoritative
 * executor all stay in the owning service. A Stent API tool has the same schema
 * and result obligations as a native DSH tool, and a waterfall listener must
 * call `next()` unless it intentionally vetoes — returning without delegation
 * is the documented veto.
 *
 * @module @oh-my-dsh/stent-dsh/host/tools
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent Tool API, provided by this package. */
    stentTools: StentToolsService
  }
}

/**
 * Cooperative Mod-facing tool registry API.
 *
 * Every registration returns the exact disposer of the underlying registry or
 * `ctx.on()` effect and keeps the authoritative owner's ordering, cancellation,
 * and disposal semantics. The service never stores a parallel copy of tool
 * state.
 */
export class StentToolsService extends Service {
  /** Service key under which this class registers on `ctx`. */
  static provide = 'stentTools'
  /** The authoritative tool registry must be mounted. */
  static inject = ['tools']

  /**
   * Create and install the Tool API.
   *
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'stentTools')
  }

  /**
   * Register one tool through the authoritative registry.
   *
   * @param definition - Tool schema, execution, and optional
   *   finalization/presentation callbacks.
   * @returns The exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition): () => void {
    return this.ctx.tools.register(definition)
  }

  /**
   * Observe or gate dispatch through `tools/pre-execute`.
   *
   * @param listener - The waterfall listener; call `next()` to delegate, return
   *   without it to veto.
   * @returns The exact `ctx.on()` disposer removing this listener.
   */
  onPreExecute(
    listener: (
      exec: ToolExecution,
      next: () => Promise<PreToolDecision>,
    ) => Promise<PreToolDecision>,
  ): () => boolean {
    return this.ctx.on('tools/pre-execute', listener)
  }

  /**
   * Observe or shape a normalized dispatch outcome through
   * `tools/post-execute`.
   *
   * @param listener - The waterfall listener; call `next()` to accept the
   *   result unchanged.
   * @returns The exact `ctx.on()` disposer removing this listener.
   */
  onPostExecute(
    listener: (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ) => Promise<PostToolDecision>,
  ): () => boolean {
    return this.ctx.on('tools/post-execute', listener)
  }
}
