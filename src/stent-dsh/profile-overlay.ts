type PatchRow = Record<string, unknown> & {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: unknown
}

const configDumpFlags = new Set(['--dump-config', '--dump-default-config'])

function isRecord(value: unknown): value is Record<string, unknown> {
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
  const config = row.config
  if (!isRecord(config)) {
    return undefined
  }
  return config.stent
}

function assertNoPatchConfig(id: string, row: PatchRow): void {
  const stentConfig = stentConfigOf(row)
  if (!isRecord(stentConfig)) {
    return
  }
  if (!Object.prototype.hasOwnProperty.call(stentConfig, 'patches')) {
    return
  }
  throw new Error(
    `stent-dsh: profile row ${JSON.stringify(id)} uses config.stent.patches; register patch metadata in plugin code instead`,
  )
}

function requiresStent(row: PatchRow): boolean {
  const stentConfig = stentConfigOf(row)
  if (stentConfig === true) {
    return true
  }
  return isRecord(stentConfig)
}

function shouldEnableRow(
  id: string,
  row: PatchRow,
  canEnableDynamicRows: boolean,
): boolean {
  if (!canEnableDynamicRows) {
    return false
  }
  if (id === 'stent') {
    return false
  }
  if (!requiresStent(row)) {
    return false
  }
  return row.disabled !== false
}

function addIntegrationOverlay(
  rows: ReadonlyMap<string, PatchRow>,
  enableOverlay: PatchRow[],
): void {
  const integration = rows.get('stent-dsh')
  if (integration === undefined) {
    return
  }
  if (integration.disabled === false) {
    return
  }
  if (enableOverlay.some((row) => row.id === 'stent-dsh')) {
    return
  }
  enableOverlay.push({ id: 'stent-dsh', disabled: false })
}

function createEnableOverlay(
  rows: ReadonlyMap<string, PatchRow>,
  passthrough: readonly string[],
): PatchRow[] {
  const canEnableDynamicRows =
    passthrough[0] !== 'plugin' && !isConfigDump(passthrough)
  if (!canEnableDynamicRows) {
    return []
  }

  const enableOverlay: PatchRow[] = []
  for (const [id, row] of rows) {
    assertNoPatchConfig(id, row)
    if (shouldEnableRow(id, row, canEnableDynamicRows)) {
      enableOverlay.push({ id, disabled: false })
    }
  }
  addIntegrationOverlay(rows, enableOverlay)
  return enableOverlay
}

export { createEnableOverlay }
export type { PatchRow }
