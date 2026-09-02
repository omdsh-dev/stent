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

/** Delay before the deferred post-boot patch check starts. */
const PATCH_CHECK_DELAY_MS = 0
/** Delay allowed for binding reports to flush before the required check. */
const BINDING_FLUSH_DELAY_MS = 1000
/** Count of patches still awaiting registration. */
const NO_PATCHES = 0
/** Count of bindings still awaiting transformation hooks. */
const NO_BINDINGS = 0

/** One composed profile row's config surface (the loader row shape). */
interface StentProfileRow {
  readonly name?: string
  /** Row config; `config.stent` is an activation marker, never a patch list. */
  readonly config?: unknown
  readonly disabled?: boolean
}

/** The composed profile rows this bootstrap reads (id → row). */
type StentProfileRows = ReadonlyMap<string, StentProfileRow>

/** Return whether a row config carries a removed YAML patch descriptor. */
function hasStentPatches(config: unknown): boolean {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return false
  }
  if (!('stent' in config)) {
    return false
  }
  const stent: unknown = config.stent
  if (stent === null || typeof stent !== 'object' || Array.isArray(stent)) {
    return false
  }
  return Object.hasOwn(stent, 'patches')
}

/** Reject removed YAML patch descriptors at every bootstrap boundary. */
function assertDynamicProfile(rows: StentProfileRows): void {
  for (const [id, row] of rows) {
    if (hasStentPatches(row.config)) {
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

/** Format the hook lines for one patch in the post-boot summary order. */
function formatPatchLines(
  patch: StentPatchInfo,
  runtime: {
    readonly bindingsOf: (id: string) => readonly StentBinding[]
  },
): string[] {
  const bindings = runtime.bindingsOf(patch.id)
  if (bindings.length === NO_BINDINGS) {
    return [`  not hooked ${patch.id} (target not loaded at boot)`]
  }
  const lines: string[] = []
  for (const binding of bindings) {
    lines.push(
      `  hooked ${patch.id} → ${binding.module} ${binding.file} (${binding.nodes} node(s))`,
    )
  }
  return lines
}

/** Print the post-boot summary for patches registered by plugin code. */
function logHookSummary(
  patches: readonly StentPatchInfo[],
  runtime: {
    readonly bindingsOf: (id: string) => readonly StentBinding[]
  },
): void {
  if (patches.length === NO_PATCHES) {
    return
  }
  const lines: string[] = []
  for (const patch of patches) {
    lines.push(...formatPatchLines(patch, runtime))
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
function scheduleRequiredPatchCheck(ctx: Readonly<Context>): void {
  if (!isStentDshLaunch()) {
    return
  }
  ctx.effect(async (): Promise<() => void> => {
    const { setTimeout: defer } = await import('node:timers/promises')
    await defer(PATCH_CHECK_DELAY_MS)
    const { checkRequiredPatches, flushBindingReports } =
      await import('@oh-my-dsh/stent/node')
    const { runtime } = await import('@oh-my-dsh/stent')
    await flushBindingReports(BINDING_FLUSH_DELAY_MS)
    checkRequiredPatches()
    logHookSummary(runtime.list(), runtime)
    return (): void => {
      /* Nothing to release: the deferred check ran to completion. */
    }
  }, 'stent: required patch check')
}

export {
  installStentBootstrap,
  checkStentRequiredPatches,
  scheduleRequiredPatchCheck,
}
export type { StentProfileRow, StentProfileRows }
