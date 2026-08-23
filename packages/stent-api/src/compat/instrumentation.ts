import { patchInstrumentation } from '@oh-my-dsh/stent'
import type { StentInstrumentationConfig } from '@oh-my-dsh/stent'
import type { StentCompatConfig } from './types.ts'

/**
 * Build load-time instrumentations for all declared compat observation targets.
 * Malformed targets fail during bootstrap rather than becoming inert silently.
 */
export function buildCompatInstrumentations(config: StentCompatConfig): StentInstrumentationConfig[] {
  return (config.targets ?? []).map(target =>
    patchInstrumentation({
      id: target.patch.id,
      target: target.patch.target,
      operation: target.patch.operation,
    }),
  )
}
