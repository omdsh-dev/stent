/**
 * Browser half of `stent`: a client plugin entry that installs the bridge
 * handle and mounts the platform-free `StentService` in the browser Cordis
 * tree.
 *
 * Client bundles are transformed at build time and their calls fall back to the
 * original body until this entry materializes and installs the bridge — so a
 * patch only takes effect for calls that happen after the browser Stent runtime
 * is up. Patch handlers are registered by other browser plugins through
 * `ctx.stent.register`.
 *
 * The exports are limited to platform-free faces (`../../service.ts`,
 * `../../bridge.ts`, `../../runtime.ts`): the node half of this package imports
 * `node:*` modules and must never enter the browser bundle.
 *
 * @module @oh-my-dsh/stent/client
 */

import type { Context } from '@deepseek-ai/cordis'

import { markStentDshLaunch } from '#src/activation'
import { installBridge } from '#src/bridge'
import { StentService } from '#src/service'

/** Cordis plugin name used by Loader diagnostics. */
const name = 'stent'

/**
 * Install the Stent runtime from the approved browser client entry.
 *
 * The marker is written before mounting `StentService`: dependent client
 * plugins use the same Cordis availability gate as Node plugins.
 *
 * @param ctx - Cordis context that owns the service.
 */
async function apply(ctx: Context): Promise<void> {
  markStentDshLaunch()
  installBridge()
  await ctx.plugin(StentService)
}

export { apply, name }
export { installBridge } from '#src/bridge'
export { runtime } from '#src/runtime'
export { StentService } from '#src/service'
export type { StentPatch, StentPatchInfo } from '#src/types'
