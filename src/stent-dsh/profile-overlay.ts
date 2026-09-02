/**
 * Patch rows one launch composes: which bundles a profile declares, where each
 * bundle's patch layer lives, and which rows the launch must enable.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

type RecordValue = Readonly<Record<string, unknown>>
type PatchLayer = readonly unknown[]
type PatchRow = RecordValue & {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: RecordValue
  readonly insert?: unknown
}
/** One composed row: the id it is indexed under, and the merged row itself. */
type PatchRowEntry = readonly [string, PatchRow]

/** Position of the dsh subcommand inside the forwarded argument list. */
const SUBCOMMAND_INDEX = 0

const configDumpFlags = new Set(['--dump-config', '--dump-default-config'])

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

/** Read a JSON manifest, ignoring anything that does not parse to an object. */
function readJsonRecord(file: string): RecordValue | undefined {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed)) {
    return undefined
  }
  return parsed
}

/** The patch file a bundle manifest declares, resolved against that manifest. */
function bundlePatchOf(
  manifest: RecordValue,
  manifestPath: string,
): string | undefined {
  if (!isRecord(manifest.dsh) || !isRecord(manifest.dsh.bundle)) {
    return undefined
  }
  const { patch } = manifest.dsh.bundle
  if (typeof patch !== 'string') {
    return undefined
  }
  return path.resolve(path.dirname(manifestPath), patch)
}

/** The patch file of one declared bundle, if it resolves and declares one. */
function bundlePatchFile(
  resolveBundle: (specifier: string) => string,
  bundle: unknown,
): string | undefined {
  if (typeof bundle !== 'string') {
    return undefined
  }
  try {
    const manifestPath = resolveBundle(`${bundle}/package.json`)
    const manifest = readJsonRecord(manifestPath)
    if (manifest === undefined) {
      return undefined
    }
    return bundlePatchOf(manifest, manifestPath)
  } catch {
    return undefined
  }
}

function declaredBundles(manifest: RecordValue | undefined): PatchLayer {
  if (manifest === undefined || !isRecord(manifest.dsh)) {
    return []
  }
  const { profile } = manifest.dsh
  if (!isRecord(profile) || !Array.isArray(profile.bundles)) {
    return []
  }
  return profile.bundles
}

/** Bundles the profile manifest declares, in declaration order. */
function profileBundles(manifestPath: string): PatchLayer {
  if (!existsSync(manifestPath)) {
    return []
  }
  return declaredBundles(readJsonRecord(manifestPath))
}

function isConfigDump(passthrough: readonly string[]): boolean {
  for (const argument of passthrough) {
    if (configDumpFlags.has(argument)) {
      return true
    }
  }
  return false
}

function stentConfigOf(row: PatchRow): unknown {
  const { config } = row
  if (!isRecord(config)) {
    return undefined
  }
  return config.stent
}

function assertNoPatchConfig(id: string, row: PatchRow): void {
  const stentConfig = stentConfigOf(row)
  if (!isRecord(stentConfig) || !Object.hasOwn(stentConfig, 'patches')) {
    return
  }
  throw new Error(
    `stent-dsh: profile row ${JSON.stringify(id)} uses config.stent.patches; register patch metadata in plugin code instead`,
  )
}

function shouldEnableRow(id: string, row: PatchRow): boolean {
  if (id === 'stent' || row.disabled === false) {
    return false
  }
  const stentConfig = stentConfigOf(row)
  return stentConfig === true || isRecord(stentConfig)
}

/** Overlay rows for every Stent-aware plugin the profile left disabled. */
function dynamicOverlayRows(rows: readonly PatchRowEntry[]): PatchRow[] {
  const enableOverlay: PatchRow[] = []
  for (const [id, row] of rows) {
    assertNoPatchConfig(id, row)
    if (shouldEnableRow(id, row)) {
      enableOverlay.push({ id, disabled: false })
    }
  }
  return enableOverlay
}

/** The composed row indexed under `id`, when the profile declares one. */
function rowById(
  rows: readonly PatchRowEntry[],
  id: string,
): PatchRow | undefined {
  for (const [rowId, row] of rows) {
    if (rowId === id) {
      return row
    }
  }
  return undefined
}

/** The overlay row that activates the DSH integration, when it is needed. */
function integrationOverlayRow(
  rows: readonly PatchRowEntry[],
  enableOverlay: readonly PatchRow[],
): PatchRow | undefined {
  const integration = rowById(rows, 'stent-dsh')
  if (integration === undefined || integration.disabled === false) {
    return undefined
  }
  if (enableOverlay.some((row) => row.id === 'stent-dsh')) {
    return undefined
  }
  return { id: 'stent-dsh', disabled: false }
}

function createEnableOverlay(
  rows: readonly PatchRowEntry[],
  passthrough: readonly string[],
): PatchRow[] {
  if (passthrough[SUBCOMMAND_INDEX] === 'plugin' || isConfigDump(passthrough)) {
    return []
  }

  const enableOverlay = dynamicOverlayRows(rows)
  const integration = integrationOverlayRow(rows, enableOverlay)
  if (integration !== undefined) {
    enableOverlay.push(integration)
  }
  return enableOverlay
}

export { bundlePatchFile, createEnableOverlay, profileBundles }
