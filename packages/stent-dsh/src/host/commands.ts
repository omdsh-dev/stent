/**
 * The Stent Command API module: a stable, Mod-facing surface for human commands
 * over the authoritative command registry.
 *
 * The facade delegates every call to `ctx.commands`. Commands remain outside
 * model turns unless the owning command contract explicitly starts one, and
 * registration conflicts, availability, and disposal use the domain registry's
 * rules.
 *
 * @module @oh-my-dsh/stent-dsh/host/commands
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CommandDefinition,
  CommandDescriptor,
} from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent Command API, provided by this package. */
    stentCommands: StentCommandsService
  }
}

/**
 * Cooperative Mod-facing command registry API.
 *
 * Registrations return the exact effect disposer of the owning registry and
 * keep its conflict and disposal semantics. The service never stores a parallel
 * copy of command state.
 */
class StentCommandsService extends Service {
  /** Service key under which this class registers on `ctx`. */
  static provide = 'stentCommands'
  /** The authoritative command registry must be mounted. */
  static inject = ['commands']

  /**
   * Create and install the Command API.
   *
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'stentCommands')
  }

  /**
   * Register one human command through the authoritative registry.
   *
   * @param definition - Discovery metadata and direct UI handler.
   * @returns The exact effect disposer that unregisters this definition.
   */
  register(definition: CommandDefinition): () => void {
    return this.ctx.commands.register(definition)
  }

  /**
   * List the effective immutable command descriptors for one agent.
   *
   * @param agent - Exact receiving agent and scoped-layer key.
   * @returns Name-sorted descriptors after scoped shadowing.
   */
  list(agent: Agent): readonly CommandDescriptor[] {
    return this.ctx.commands.list(agent)
  }
}

export { StentCommandsService }
