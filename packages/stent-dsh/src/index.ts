/**
 * DSH integrations for the Cordis Stent layer.
 *
 * The package mounts the DSH-facing Host facades (`ctx.stentAgent`,
 * `ctx.stentTools`, `ctx.stentPrompt`, `ctx.stentCommands`), a browser
 * facade (`ctx.stentClient`) that delegates to the authoritative DSH
 * client services, the package invariant companion, and the DSH profile
 * bootstrap that installs the runtime-driven Stent transformation hooks.
 * Patch metadata and handlers are supplied by plugin code through
 * `ctx.stent.register()`; profile rows only control plugin activation. Mount
 * this entry to provide all Host modules; mount a subpath to provide one module.
 * @module @oh-my-dsh/stent-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import { StentAgentService } from './host/agent.ts'
import { StentToolsService } from './host/tools.ts'
import { StentPromptService } from './host/prompt.ts'
import { StentCommandsService } from './host/commands.ts'
import { scheduleRequiredPatchCheck } from './bootstrap/profile.ts'
import { registerCatalogEntries } from './catalog.ts'

export { StentAgentService } from './host/agent.ts'
export { StentToolsService } from './host/tools.ts'
export { StentPromptService } from './host/prompt.ts'
export { StentCommandsService } from './host/commands.ts'
export {
  installStentBootstrap,
  checkStentRequiredPatches,
  scheduleRequiredPatchCheck,
  type StentProfileRow,
  type StentProfileRows,
} from './bootstrap/profile.ts'
export { STENT_CATALOG_ENTRIES, registerCatalogEntries } from './catalog.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'stent-dsh'
/** The four authoritative Host services the modules delegate to. */
export const inject = ['tools', 'systemPrompt', 'commands']

/**
 * Mount all four Host Stent API modules.
 * @param ctx - Cordis context that owns the services.
 */
export async function apply(ctx: Context): Promise<void> {
  void registerCatalogEntries()
  await ctx.plugin(StentAgentService)
  await ctx.plugin(StentToolsService)
  await ctx.plugin(StentPromptService)
  await ctx.plugin(StentCommandsService)
  // Post-boot patch verification under the stent-dsh launcher (no-op for
  // plain dsh): the launcher installs the dynamic hooks before plugins run;
  // plugin code owns metadata, handlers, and required-patch declarations.
  scheduleRequiredPatchCheck(ctx)
}
