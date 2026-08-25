/**
 * DSH profile bootstrap for the Stent layer: read the composed
 * `stent` row's static patch descriptors from a profile's rows and
 * install the load-time transformation hooks before any target plugin
 * module imports, plus the post-boot binding verification. This is the DSH
 * assembly half of `stent` — the pure package only knows how to
 * install hooks from descriptors, not where a deployment composes them.
 * @module @oh-my-dsh/stent-dsh/bootstrap/profile
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StentPatchStub } from '@oh-my-dsh/stent/types'

/** One composed profile row's config surface (the loader row shape). */
export interface StentProfileRow {
  name?: string
  config?: unknown
  disabled?: boolean
}

/** The composed profile rows this bootstrap reads (id → row). */
export type StentProfileRows = ReadonlyMap<string, StentProfileRow>

/** One Stent row's config surface: the namespaced patch stubs. */
interface StentRowConfig {
  stent?: { patches?: unknown }
}

/**
 * Read the composed `stent` row's patch stubs from the dedicated
 * `config.stent.patches` section. The row's `disabled` flag governs
 * mounting the plugin only; the bootstrap reads this section whenever it is
 * present.
 * @param rowConfig - the row's config, when the row exists.
 * @returns the patch descriptors, or undefined when none are declared.
 */
function stentDescriptors(rowConfig: StentRowConfig | undefined): unknown {
  return rowConfig?.stent?.patches
}

/**
 * Install the Stent transformation hooks from the composed profile rows.
 *
 * The optional `stent` row may carry static patch descriptors under
 * `config.stent.patches` (id/target/operation — handlers are trusted code
 * bound at registration). The hooks must exist before any target plugin is
 * imported, so this runs in the boot `prepare` phase, before the config tree
 * mounts. The row's `disabled` flag governs mounting the plugin (the browser
 * roster keeps the row disabled by default); it does not suppress the
 * load-time bootstrap — patches from the composed row apply whenever the row
 * carries them. When the row is absent or carries no patches, nothing is
 * installed.
 * @param rows - the fully composed profile rows for this invocation.
 */
export async function installStentBootstrap(rows: StentProfileRows): Promise<void> {
  const stentRow = [...rows].find(([id]) => id === 'stent')?.[1]
  const descriptors = stentDescriptors(stentRow?.config as StentRowConfig | undefined)
  if (!Array.isArray(descriptors) || descriptors.length === 0) return
  const { expandPatchStub, installStentHooks } = await import('@oh-my-dsh/stent/node/loader')
  installStentHooks((descriptors as StentPatchStub[]).flatMap(expandPatchStub))
}

/**
 * Verify the composed profile's `required` Stent patches bound at load
 * time. Runs after the config tree mounts (boot completion), when every
 * target module has been imported and the transformation hooks recorded
 * their bindings; a required patch that bound nothing fails the launch
 * loud, naming the patch id and its target, instead of shipping an inert
 * transform.
 * @param rows - the fully composed profile rows for this invocation.
 */
export async function checkStentRequiredPatches(rows: StentProfileRows): Promise<void> {
  const stentRow = [...rows].find(([id]) => id === 'stent')?.[1]
  const descriptors = stentDescriptors(stentRow?.config as StentRowConfig | undefined)
  if (!Array.isArray(descriptors) || descriptors.length === 0) return
  const { checkRequiredPatches } = await import('@oh-my-dsh/stent')
  checkRequiredPatches(descriptors as StentPatchStub[])
}

/** The live loader's composed entries, read as the id → row map. */
function composedStentRows(ctx: Context): StentProfileRows {
  const rows = new Map<string, StentProfileRow>()
  const loader = (
    ctx as unknown as {
      loader?: {
        entries?: () => Iterable<{ options?: Partial<{ id?: unknown; config?: unknown; disabled?: unknown }> }>
      }
    }
  ).loader
  for (const entry of loader?.entries?.() ?? []) {
    const options = entry.options
    if (options !== undefined && typeof options.id === 'string') {
      const row: StentProfileRow = { config: options.config }
      if (typeof options.disabled === 'boolean') row.disabled = options.disabled
      rows.set(options.id, row)
    }
  }
  return rows
}

/**
 * Stent-required rows: rows (the stent carrier aside) whose config
 * declares `config.stent.patches`. They ship disabled and the stent-dsh
 * launcher enables them; the post-boot check uses this list to catch a boot
 * where such a row is enabled WITHOUT the hooks (a misconfigured plain
 * `dsh` launch) or where the hooks are present but a required patch bound
 * nothing.
 */
function stentRequiredRows(rows: StentProfileRows): Array<{ id: string; disabled?: boolean }> {
  const out: Array<{ id: string; disabled?: boolean }> = []
  for (const [id, row] of rows) {
    if (id === 'stent') continue
    const raw = stentDescriptors(row.config as StentRowConfig | undefined)
    if (Array.isArray(raw) && raw.length > 0) {
      const entry: { id: string; disabled?: boolean } = { id }
      if (typeof row.disabled === 'boolean') entry.disabled = row.disabled
      out.push(entry)
    }
  }
  return out
}

/** One recorded load-time binding, as the runtime reports it. */
interface StentBindingView {
  module: string
  file: string
  nodes: number
}

/**
 * Print the post-boot hook summary: which patch bound to which target file.
 * Runs under stent-dsh after the required check, so the boot output lists
 * exactly what the Stent layer hooked (or that a target never loaded).
 * Written straight to stderr like the preload's launch marker, so no
 * logging-level filter can hide it.
 */
function logHookSummary(
  descriptors: readonly StentPatchStub[],
  runtime: { bindingsOf: (id: string) => StentBindingView[] },
): void {
  if (descriptors.length === 0) return
  const lines: string[] = []
  for (const patch of descriptors) {
    const bindings = runtime.bindingsOf(patch.id)
    if (bindings.length === 0) {
      lines.push(`  not hooked ${patch.id} (target not loaded at boot)`)
      continue
    }
    for (const binding of bindings) {
      lines.push(`  hooked ${patch.id} → ${binding.module} ${binding.file} (${binding.nodes} node(s))`)
    }
  }
  process.stderr.write(`stent: hooks summary — ${descriptors.length} patch(es):\n${lines.join('\n')}\n`)
}

/**
 * Boot-completion patch check for both launch modes — the Stent gate.
 * The launcher (stent-dsh) writes the composed descriptors to
 * $STENT_CONFIG, injects the loader hooks through a preload, and
 * enables the Stent-required rows through a generated overlay; this plugin
 * schedules the check one tick after mount (all tree entries have applied
 * by then).
 *
 * - stent ON ($STENT_CONFIG present): a `required` patch that bound
 *   nothing fails the launch loud, like the patched profile-boot used to;
 *   on success the hook summary is logged;
 * - stent OFF (plain `dsh`): Stent-required rows stay disabled by default
 *   and the boot skips them (the dependent plugins simply do not load). If
 *   one is nevertheless ENABLED, the hooks are absent and its transforms
 *   can never run — the boot fails loud instead of silently degrading.
 * @param ctx - the owning context (effects ride its fiber).
 */
export function scheduleRequiredPatchCheck(ctx: Context): void {
  const configPath = process.env.STENT_CONFIG
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        if (configPath !== undefined && configPath !== '') {
          // stent ON: the exact file the preload installed from is the
          // truth of what was bound.
          const { readFileSync } = await import('node:fs')
          const { checkRequiredPatches, flushBindingReports, runtime } = await import('@oh-my-dsh/stent')
          const descriptors = JSON.parse(readFileSync(configPath, 'utf8')) as StentPatchStub[]
          // The async hook path delivers binding reports over a port; wait
          // for them before judging (no-op on the synchronous path).
          await flushBindingReports(1000)
          checkRequiredPatches(descriptors)
          logHookSummary(descriptors, runtime as unknown as { bindingsOf: (id: string) => StentBindingView[] })
          return
        }
        // stent OFF: gate on Stent-required rows that are enabled anyway.
        const enabled = stentRequiredRows(composedStentRows(ctx)).filter(({ disabled }) => disabled === false)
        if (enabled.length === 0) return
        throw new Error(
          'stent: rows ' +
            enabled.map(({ id }) => id).join(', ') +
            ' declare Stent patches but are enabled on a plain-dsh boot (the hooks are not installed); ' +
            'launch through stent-dsh, which enables Stent-required rows itself',
        )
      })()
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, 'stent: required patch check')
}
