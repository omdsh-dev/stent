/**
 * The Stent Prompt API module: a stable, Mod-facing surface for ordered system
 * sections, cache-safe contexts, tool-schema providers, and prompt variables
 * over the authoritative system-prompt registry.
 *
 * The facade delegates every call to `ctx.systemPrompt` and passes the exact
 * effect disposer through. There is no shortcut that inserts unlogged
 * model-visible text or assembles provider requests directly: everything this
 * module contributes reaches the model only through the owning registry's
 * assembly and rendering contract.
 *
 * @module @oh-my-dsh/stent-dsh/host/prompt
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AssembleContext,
  PromptContext,
  PromptSection,
  ToolProviderResult,
} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent Prompt API, provided by this package. */
    stentPrompt: StentPromptService
  }
}

/**
 * Cooperative Mod-facing system-prompt registry API.
 *
 * Each method registers in the calling context's scope through the owning
 * registry, so duplicate names, ordering, shadowing, and disposal follow the
 * authoritative contract. The service never holds a parallel copy of prompt
 * state.
 */
class StentPromptService extends Service {
  /** Service key under which this class registers on `ctx`. */
  static provide = 'stentPrompt'
  /** The authoritative system-prompt registry must be mounted. */
  static inject = ['systemPrompt']

  /**
   * Create and install the Prompt API.
   *
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'stentPrompt')
  }

  /**
   * Register an ordered system section.
   *
   * @param section - The section to register.
   * @returns The exact effect disposer that unregisters it.
   */
  section(section: PromptSection): () => void {
    return this.ctx.systemPrompt.section(section)
  }

  /**
   * Register an ordered, cache-safe dynamic context contribution.
   *
   * @param context - The context contribution to register.
   * @returns The exact effect disposer that unregisters it.
   */
  context(context: PromptContext): () => void {
    return this.ctx.systemPrompt.context(context)
  }

  /**
   * Register a tool-schema provider.
   *
   * @param provider - Evaluated for each assembly with its context.
   * @returns The exact effect disposer that unregisters it.
   */
  tools(
    provider: (context: AssembleContext) => ToolProviderResult,
  ): () => void {
    return this.ctx.systemPrompt.tools(provider)
  }

  /**
   * Register a prompt variable.
   *
   * @param name - The `[a-z][a-z0-9_]*` reference name.
   * @param provider - Evaluated for each assembly; returning `undefined` makes
   *   a referencing section fail.
   * @returns The exact effect disposer that unregisters it.
   */
  variable(
    name: string,
    provider: (context: AssembleContext) => string | undefined,
  ): () => void {
    return this.ctx.systemPrompt.variable(name, provider)
  }
}

export { StentPromptService }
