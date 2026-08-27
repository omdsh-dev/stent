/** JSON wire helpers for the async Node loader configuration channel. */

import type { StentInstrumentationConfig } from './config.ts'

/** Wire form that preserves RegExp file paths through JSON. */
export interface StentWireInstrumentation extends Omit<
  StentInstrumentationConfig,
  'module'
> {
  module: Omit<StentInstrumentationConfig['module'], 'filePath'> & {
    filePath: string | { stentRegexp: [source: string, flags: string] }
  }
}

/** Serialize one instrumentation for the loader-thread configuration file. */
export function serializeInstrumentation(
  config: StentInstrumentationConfig,
): StentWireInstrumentation {
  const filePath = config.module.filePath
  if (!(filePath instanceof RegExp)) {
    return config as StentWireInstrumentation
  }
  return {
    ...config,
    module: {
      ...config.module,
      filePath: { stentRegexp: [filePath.source, filePath.flags] },
    },
  }
}

/** Revive a serialized RegExp file path for the matcher. */
export function reviveInstrumentation(
  config: StentWireInstrumentation,
): StentInstrumentationConfig {
  const filePath = config.module.filePath
  if (typeof filePath === 'object') {
    return {
      ...config,
      module: {
        ...config.module,
        filePath: new RegExp(filePath.stentRegexp[0], filePath.stentRegexp[1]),
      },
    }
  }
  return config as StentInstrumentationConfig
}
