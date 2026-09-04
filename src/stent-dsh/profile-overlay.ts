/** Derive the Stent activation patches from the official profile composition. */

type RecordValue = Readonly<Record<string, unknown>>
type PatchRow = RecordValue & {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: RecordValue
}
type PatchRowEntry = readonly [string, unknown]

/** Position of the dsh subcommand inside the forwarded argument list. */
const SUBCOMMAND_INDEX = 0
const ROW_VALUE_INDEX = 1

const configDumpFlags = new Set(['--dump-config', '--dump-default-config'])

function isRecord(value: unknown): value is PatchRow {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
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
  for (const [id, value] of rows) {
    if (isRecord(value)) {
      assertNoPatchConfig(id, value)
      if (shouldEnableRow(id, value)) {
        enableOverlay.push({ id, disabled: false })
      }
    }
  }
  return enableOverlay
}

/** The overlay row that activates the DSH integration, when it is needed. */
function integrationOverlayRow(
  rows: readonly PatchRowEntry[],
  enableOverlay: readonly PatchRow[],
): PatchRow | undefined {
  const integration = rows.find(([id]) => id === 'stent-dsh')?.[ROW_VALUE_INDEX]
  if (!isRecord(integration) || integration.disabled === false) {
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

export { createEnableOverlay }
