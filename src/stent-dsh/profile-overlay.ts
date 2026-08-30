export type PatchRow = Record<string, unknown> & {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

export function createEnableOverlay(
  rows: ReadonlyMap<string, PatchRow>,
  passthrough: readonly string[],
): PatchRow[] {
  const mode = passthrough[0]
  const isConfigDump =
    passthrough.includes('--dump-config')
    || passthrough.includes('--dump-default-config')
  const canEnableDynamicRows = mode !== 'plugin' && !isConfigDump
  const enableOverlay: PatchRow[] = []

  for (const [id, row] of rows) {
    const config = isRecord(row.config) ? row.config : undefined
    const stentConfig = config?.stent
    if (
      isRecord(stentConfig)
      && Object.prototype.hasOwnProperty.call(stentConfig, 'patches')
    ) {
      throw new Error(
        `stent-dsh: profile row ${JSON.stringify(id)} uses config.stent.patches; register patch metadata in plugin code instead`,
      )
    }
    const requiresStent =
      config !== undefined && (config.stent === true || isRecord(config.stent))
    if (
      canEnableDynamicRows
      && id !== 'stent'
      && requiresStent
      && row.disabled !== false
    ) {
      enableOverlay.push({ id, disabled: false })
    }
  }

  if (canEnableDynamicRows) {
    const integration = rows.get('stent-dsh')
    if (
      integration !== undefined
      && integration.disabled !== false
      && !enableOverlay.some((row) => row.id === 'stent-dsh')
    ) {
      enableOverlay.push({ id: 'stent-dsh', disabled: false })
    }
  }
  return enableOverlay
}
