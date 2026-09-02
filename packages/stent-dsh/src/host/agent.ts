/**
 * The Stent Agent API module: a stable, Mod-facing subset of agent/session
 * lifecycle observation and operation-local context injection.
 *
 * The facade delegates to the authoritative `agent/*` events and the Agent's
 * own injection path. It deliberately does not expose the concrete
 * `dsh-agent-loop`, private queue state, or mutable session internals:
 * callbacks receive the live Agent only where the owning event already does,
 * and every registration returns the exact disposer of the underlying
 * `ctx.on()` effect, so disposal and scope semantics are inherited unchanged.
 *
 * @module @oh-my-dsh/stent-dsh/host/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent Agent API, provided by this package. */
    stentAgent: StentAgentService
  }
}

/**
 * Cooperative Mod-facing Agent lifecycle API.
 *
 * The service is thin by design: it selects a stable subset of the
 * authoritative agent events and the logged injection path, and passes the
 * underlying disposer through untouched. A listener or injected message is
 * owned by the calling fiber and removed with it.
 */
class StentAgentService extends Service {
  /** Service key under which this class registers on `ctx`. */
  public static provide = 'stentAgent'

  /**
   * Create and install the Agent API.
   *
   * @param ctx - Cordis context that owns the service.
   */
  public constructor(ctx: Context) {
    super(ctx, 'stentAgent')
  }

  /**
   * Observe a live agent being created.
   *
   * @param listener - Called with the created agent.
   * @returns The exact `ctx.on()` disposer removing this listener.
   */
  public onCreated(listener: (agent: Agent) => void): () => boolean {
    return this.ctx.on('agent/created', (payload) => {
      listener(payload.agent)
    })
  }

  /**
   * Observe a live agent being disposed.
   *
   * @param listener - Called with the disposed agent.
   * @returns The exact `ctx.on()` disposer removing this listener.
   */
  public onDisposed(listener: (agent: Agent) => void): () => boolean {
    return this.ctx.on('agent/disposed', (payload) => {
      listener(payload.agent)
    })
  }

  /**
   * Observe an agent's idle/running status transitions.
   *
   * @param listener - Called with the agent and its new status.
   * @returns The exact `ctx.on()` disposer removing this listener.
   */
  public onStatus(
    listener: (agent: Agent, status: AgentStatus) => void,
  ): () => boolean {
    return this.ctx.on('agent/status', (payload) => {
      listener(payload.agent, payload.status)
    })
  }

  /**
   * Inject a logged, model-visible user message into one agent's context.
   *
   * The message goes through `agent.inject()`, the Agent's own durable
   * injection path: anything this API contributes to a model request is
   * reconstructable from the session log. No provider request is assembled
   * here.
   *
   * @param agent - The live agent to inject into.
   * @param message - The sourced user message to append.
   */
  public inject(agent: Agent, message: UserMessage): void {
    agent.inject(message)
  }
}

export { StentAgentService }
