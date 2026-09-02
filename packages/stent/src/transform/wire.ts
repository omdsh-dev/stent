/**
 * Encode and decode instrumentation configs at the async-loader JSON boundary.
 * These helpers only convert the in-memory shape; they do not stringify, parse,
 * read, or write JSON themselves.
 *
 * JavaScript regular expressions are not JSON values, so a `RegExp` file path
 * is represented by its source and flags while the config is in transit. String
 * paths and the rest of the instrumentation shape pass through unchanged.
 *
 * @module @oh-my-dsh/stent/transform/wire
 */

import type { StentInstrumentationConfig } from './config.ts'

/** JSON-safe instrumentation shape; only `module.filePath` changes form. */
interface StentWireInstrumentation extends Omit<
  StentInstrumentationConfig,
  'module'
> {
  module: Omit<StentInstrumentationConfig['module'], 'filePath'> & {
    filePath: string | { stentRegexp: [source: string, flags: string] }
  }
}

/**
 * Convert an internal config to the JSON-safe loader representation.
 *
 * @param config - Expanded instrumentation consumed by the loader.
 * @returns The same config shape, with a regular-expression path encoded when
 *   necessary.
 */
function serializeInstrumentation(
  config: StentInstrumentationConfig,
): StentWireInstrumentation {
  const { filePath } = config.module
  if (!(filePath instanceof RegExp)) {
    return {
      ...config,
      module: {
        ...config.module,
        filePath,
      },
    }
  }
  return {
    ...config,
    module: {
      ...config.module,
      filePath: { stentRegexp: [filePath.source, filePath.flags] },
    },
  }
}

/**
 * Restore a JSON-safe config before handing it to the matcher.
 *
 * @param config - Parsed loader configuration.
 * @returns A matcher-ready config with encoded regular-expression paths
 *   revived.
 * @throws If an object file-path marker is malformed or its RegExp is invalid.
 */
function reviveInstrumentation(
  config: StentWireInstrumentation,
): StentInstrumentationConfig {
  const { filePath } = config.module
  if (typeof filePath === 'object') {
    const [source, flags] = filePath.stentRegexp
    return {
      ...config,
      module: {
        ...config.module,
        filePath: new RegExp(source, flags),
      },
    }
  }
  return {
    ...config,
    module: {
      ...config.module,
      filePath,
    },
  }
}

export { serializeInstrumentation, reviveInstrumentation }
export type { StentWireInstrumentation }
