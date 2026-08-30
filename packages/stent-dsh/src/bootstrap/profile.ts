/**
 * DSH profile bootstrap for dynamic Stent registration.
 *
 * Profile rows decide which plugins are mounted, but they no longer carry
 * executable patch descriptors. The launcher preload installs an empty,
 * runtime-driven loader before the host imports plugins; plugin code then calls
 * `ctx.stent.register()` with patch metadata and its handler.
 *
 * @module @oh-my-dsh/stent-dsh/bootstrap/profile
 */

import type { Context } from '@deepseek-ai/cordis'
import { isStentDshLaunch } from '@oh-my-dsh/stent/activation'
import type { StentBinding, StentPatchInfo } from '@oh-my-dsh/stent/types'

/** One composed profile row's config surface (the loader row shape). */
interface StentProfileRow {
  name?: string
  /** Row config; `config.stent` is an activation marker, never a patch list. */
  config?: unknown
  disabled?: boolean
}

/** The composed profile rows this bootstrap reads (id → row). */
type StentProfileRows = ReadonlyMap<string, StentProfileRow>

/** Reject removed YAML patch descriptors at every bootstrap boundary. */
function assertDynamicProfile(rows: StentProfileRows): void {
  for (const [id, row] of rows) {
    if (
      row.config === null
      || typeof row.config !== 'object'
      || Array.isArray(row.config)
    ) {
      continue
    }
    const stent = (row.config as { stent?: unknown }).stent
    if (stent === null || typeof stent !== 'object' || Array.isArray(stent)) {
      continue
    }
    if (Object.prototype.hasOwnProperty.call(stent, 'patches')) {
      throw new Error(
        `stent-dsh: profile row ${JSON.stringify(id)} uses config.stent.patches; register patch metadata in plugin code instead`,
      )
    }
  }
}

/**
 * Install the runtime-driven transformation hooks for a composed Stent row.
 *
 * The launcher preload normally installs these hooks first. This exported
 * bootstrap remains useful to embedders that compose profiles without the
 * launcher: it installs the dynamic matcher and leaves all patch metadata to
 * plugin code. Calling it from a launcher boot is skipped because the preload
 * installation already handles the target modules.
 */
async function installStentBootstrap(rows: StentProfileRows): Promise<void> {
  assertDynamicProfile(rows)
  if (!rows.has('stent') || isStentDshLaunch()) {
    return
  }
  const { installStentHooks } = await import('@oh-my-dsh/stent/node')
  installStentHooks()
}

/** Verify all dynamically registered required patches after profile boot. */
async function checkStentRequiredPatches(
  rows: StentProfileRows,
): Promise<void> {
  assertDynamicProfile(rows)
  const { checkRequiredPatches } = await import('@oh-my-dsh/stent/node')
  checkRequiredPatches()
}

/** Print the post-boot summary for patches registered by plugin code. */
function logHookSummary(
  patches: readonly StentPatchInfo[],
  runtime: { bindingsOf: (id: string) => readonly StentBinding[] },
): void {
  if (patches.length === 0) {
    return
  }
  const lines: string[] = []
  for (const patch of patches) {
    const bindings = runtime.bindingsOf(patch.id)
    if (bindings.length === 0) {
      lines.push(`  not hooked ${patch.id} (target not loaded at boot)`)
      continue
    }
    for (const binding of bindings) {
      lines.push(
        `  hooked ${patch.id} → ${binding.module} ${binding.file} (${binding.nodes} node(s))`,
      )
    }
  }
  process.stderr.write(
    `stent: hooks summary — ${patches.length} patch(es):\n${lines.join('\n')}\n`,
  )
}

/**
 * Run the dynamic required-patch check once the Cordis tree has mounted.
 *
 * Plain `dsh` does not set the Stent launch marker and therefore skips this
 * check. The launcher enables Stent-dependent profile rows through its
 * generated row overlay; those plugins register their own metadata while the
 * dynamic hooks are already active.
 */
function scheduleRequiredPatchCheck(ctx: Context): void {
  if (!isStentDshLaunch()) {
    return
  }
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        const { checkRequiredPatches, flushBindingReports } =
          await import('@oh-my-dsh/stent/node')
        const { runtime } = await import('@oh-my-dsh/stent')
        await flushBindingReports(1000)
        checkRequiredPatches()
        logHookSummary(runtime.list(), runtime)
      })()
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, 'stent: required patch check')
}

export {
  installStentBootstrap,
  checkStentRequiredPatches,
  scheduleRequiredPatchCheck,
}
export type { StentProfileRow, StentProfileRows }
