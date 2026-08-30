/**
 * Async module-hook entry for Stent, used by `installStentHooks` on Node
 * versions without a reliable synchronous `registerHooks` API. Registered
 * exactly once through `module.register` (which runs this module on the loader
 * thread), it transforms matching ESM modules at load time and defers CommonJS
 * to the `_compile` patch installed by the Node loader.
 *
 * The entry reads the shared configuration file (written by the main thread
 * when the single active installation changes or is disposed) on each load, so
 * the loader thread reflects the current state: a new installation after
 * disposal replaces the transform on the next module evaluation, and an evicted
 * module re-imports under the latest configuration. The public
 * `installStentHooks()` API rejects a second active installation; the
 * configuration is represented as an array for the wire format, but this entry
 * normally consumes one active state. The chain is rebuilt only when the
 * configuration content changes.
 *
 * @module @oh-my-dsh/stent/node/hook-entry
 */

import { readFileSync } from 'node:fs'
import type { MessagePort } from 'node:worker_threads'

import { createInstrumentedTransform } from '../transform/browser.ts'
import { resolvePackageIdentity } from '../transform/identity.ts'
import {
  reviveInstrumentation,
  type StentWireInstrumentation,
} from '../transform/wire.ts'
import type { StentBindingReport } from '../types.ts'

/** Shared configuration path, passed through `module.register` data. */
let configPath: string | undefined

/** Main-thread binding channel end, passed through `module.register` data. */
let bindingPort: MessagePort | undefined

/** Transform for the active installation's loader-thread snapshot. */
type TransformFn = ReturnType<typeof createInstrumentedTransform>

/** Cached transform for the last-read configuration content. */
let cached: { config: string; transforms: TransformFn[] } | undefined

/**
 * Initialize the loader-thread entry.
 *
 * @param data - `module.register` data carrying the shared config path and the
 *   main-thread binding channel end.
 */
function initialize(
  data: { configPath?: string; port?: MessagePort } = {},
): void {
  configPath = data.configPath
  bindingPort = data.port
  // Answer a main-thread flush request: every binding report posted before
  // this reply precedes it on the same channel, so the main thread can treat
  // the reply as "all reports from completed loads have landed".
  bindingPort?.on('message', (message: unknown) => {
    if (
      typeof message === 'object'
      && message !== null
      && (message as { type?: string }).type === 'flush'
    ) {
      bindingPort?.postMessage({ type: 'flush-done' })
    }
  })
}

/**
 * Read the shared configuration and return the transform list for the currently
 * active installation. The wire shape is an array, but the public loader
 * permits only one active dynamic installation. The list is rebuilt only when
 * the configuration content changed since the last load.
 *
 * @returns The transform list (empty when no installation is active or the
 *   configuration cannot be read).
 */
function readTransforms(): TransformFn[] {
  if (!configPath) {
    return []
  }
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return cached?.transforms ?? []
  }
  if (cached?.config === raw) {
    return cached.transforms
  }
  let parsed: Array<{
    active?: boolean
    instrumentations?: StentWireInstrumentation[]
  }>
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return cached?.transforms ?? []
  }
  const transforms = parsed
    .filter((entry) => entry.active === true)
    .map((entry) => {
      const instrumentations = (entry.instrumentations ?? []).map(
        reviveInstrumentation,
      )
      return instrumentations.length === 0
        ? undefined
        : createInstrumentedTransform(instrumentations, resolvePackageIdentity)
    })
    .filter((transform): transform is TransformFn => transform !== undefined)
  cached = { config: raw, transforms }
  return transforms
}

/**
 * Transform matching ESM modules before evaluation. CommonJS modules are left
 * to the `_compile` patch, which the async path runs alongside.
 *
 * @param url - The module URL.
 * @param context - The load-hook context.
 * @param nextLoad - The next hook in the chain.
 * @returns The possibly transformed load result.
 */
async function load(
  url: string,
  context: { format?: string | null },
  nextLoad: (
    url: string,
    context: unknown,
  ) => Promise<{
    source?: string | ArrayBuffer | null
    format?: string | null
    shortCircuit?: boolean
  }>,
): Promise<{
  source?: string | ArrayBuffer | null
  format?: string | null
  shortCircuit?: boolean
}> {
  const result = await nextLoad(url, context)
  if (result.format === 'commonjs') {
    return result
  }
  const transforms = readTransforms()
  if (transforms.length === 0) {
    return result
  }
  let source: string
  if (typeof result.source === 'string') {
    source = result.source
  } else if (result.source == null) {
    source = ''
  } else {
    source = Buffer.from(result.source).toString('utf8')
  }
  let transformed = false
  const reports: StentBindingReport[] = []
  for (const transform of transforms) {
    const output = transform(source, url)
    if (output) {
      source = output.code
      transformed = true
      if (output.bindings !== undefined) {
        reports.push(...output.bindings)
      }
    }
  }
  // The loader thread owns the ESM transform, so the main thread would never
  // see these files' bindings; forward them over the shared channel so the
  // binding reports and the required-patch check match the sync path.
  if (reports.length > 0) {
    bindingPort?.postMessage(reports)
  }
  if (!transformed) {
    return result
  }
  return { ...result, source, shortCircuit: true }
}

export { initialize, load }
