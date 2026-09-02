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

import { readFile } from 'node:fs/promises'
import type { MessagePort } from 'node:worker_threads'

import { createInstrumentedTransform } from '#src/transform/browser'
import { resolvePackageIdentity } from '#src/transform/identity'
import { reviveInstrumentation } from '#src/transform/wire'
import type { StentBindingReport } from '#src/types'

/** Length of an empty list, used for readable emptiness checks. */
const EMPTY_LENGTH = 0

/** Transform for the active installation's loader-thread snapshot. */
type TransformFn = ReturnType<typeof createInstrumentedTransform>

/** JSON-safe instrumentation shape accepted by the wire reviver. */
type WireInstrumentation = Parameters<typeof reviveInstrumentation>[number]

/** Matcher-ready instrumentation produced by the wire reviver. */
type RevivedInstrumentation = ReturnType<typeof reviveInstrumentation>

/** One installation entry of the shared configuration file. */
interface WireConfigEntry {
  readonly active?: boolean
  readonly instrumentations?: readonly unknown[]
}

/** `module.register` data: shared config path and binding channel end. */
interface HookEntryData {
  readonly configPath?: string
  readonly port?: Readonly<MessagePort>
}

/** A `load` hook result as this entry consumes and produces it. */
interface LoadResult {
  readonly source?: string | Readonly<ArrayBuffer> | null
  readonly format?: string | null
  readonly shortCircuit?: boolean
}

/** Result of running every active transform over one module source. */
interface TransformPass {
  readonly source: string
  readonly transformed: boolean
  readonly reports: readonly StentBindingReport[]
}

/** Loader-thread state: registration data plus the last-read snapshot. */
interface EntryState {
  configPath?: string | undefined
  bindingPort?: Readonly<MessagePort> | undefined
  cached?: { config: string; transforms: readonly TransformFn[] } | undefined
}

/** This loader thread's registration data and configuration snapshot. */
const state: EntryState = {}

/** Post a structured-cloneable payload to the main thread. */
function postToMain(message: unknown): void {
  const port = state.bindingPort
  if (port === undefined) {
    return
  }
  /* A worker `MessagePort` takes a transfer list where the DOM `postMessage`
     takes a target origin; the empty list is the documented default. */
  port.postMessage(message, [])
}

/**
 * Answer a main-thread flush request: every binding report posted before this
 * reply precedes it on the same channel, so the reply means "all reports from
 * completed loads have landed".
 */
function handleMainMessage(message: unknown): void {
  if (typeof message !== 'object' || !message) {
    return
  }
  if ('type' in message && message.type === 'flush') {
    postToMain({ type: 'flush-done' })
  }
}

/**
 * Initialize the loader-thread entry.
 *
 * @param data - `module.register` data carrying the shared config path and the
 *   main-thread binding channel end.
 */
function initialize(data: HookEntryData = {}): void {
  const { configPath, port } = data
  state.configPath = configPath
  state.bindingPort = port
  port?.on('message', handleMainMessage)
}

/** Read the shared configuration file, or `''` when it cannot be read. */
async function loadConfigText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/* The configuration file is written by this package's own main thread, so the
   guards below validate the JSON container the loader depends on and leave the
   instrumentation contents to the reviver. */

/** Whether a parsed configuration value is the entry list. */
function isWireConfig(value: unknown): value is readonly WireConfigEntry[] {
  if (!Array.isArray(value)) {
    return false
  }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return false
    }
  }
  return true
}

/** Whether one instrumentation-list element is an encoded instrumentation. */
function isWireInstrumentation(value: unknown): value is WireInstrumentation {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

/** Parse configuration text into entries; undefined when unparseable. */
function parseWireConfig(raw: string): readonly WireConfigEntry[] | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (isWireConfig(value)) {
      return value
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Revive one entry's encoded instrumentation list. */
function reviveAll(values: readonly unknown[]): RevivedInstrumentation[] {
  const revived: RevivedInstrumentation[] = []
  for (const value of values) {
    if (isWireInstrumentation(value)) {
      revived.push(reviveInstrumentation(value))
    }
  }
  return revived
}

/** Build one entry's transform; undefined when inactive or empty. */
function entryTransform(entry: WireConfigEntry): TransformFn | undefined {
  if (entry.active !== true) {
    return undefined
  }
  const instrumentations = reviveAll(entry.instrumentations ?? [])
  if (instrumentations.length === EMPTY_LENGTH) {
    return undefined
  }
  return createInstrumentedTransform(instrumentations, resolvePackageIdentity)
}

/** Build the transform list of configuration text; undefined when unparseable. */
function buildTransforms(raw: string): readonly TransformFn[] | undefined {
  const parsed = parseWireConfig(raw)
  if (parsed === undefined) {
    return undefined
  }
  const transforms: TransformFn[] = []
  for (const entry of parsed) {
    const transform = entryTransform(entry)
    if (transform !== undefined) {
      transforms.push(transform)
    }
  }
  return transforms
}

/** Rebuild the cache for fresh text, keeping the last list when unparseable. */
function refreshCache(raw: string): readonly TransformFn[] {
  const transforms = buildTransforms(raw)
  if (transforms === undefined) {
    return state.cached?.transforms ?? []
  }
  state.cached = { config: raw, transforms }
  return transforms
}

/**
 * Read the shared configuration and return the active installation's transform
 * list. The wire shape is an array, but the public loader permits only one
 * active dynamic installation; the list is rebuilt only when the configuration
 * content changed since the last load, and is empty when no installation is
 * active or the configuration cannot be read.
 */
async function readTransforms(): Promise<readonly TransformFn[]> {
  const { configPath, cached } = state
  if (configPath === undefined || configPath === '') {
    return []
  }
  const raw = await loadConfigText(configPath)
  if (cached?.config === raw) {
    return cached.transforms
  }
  return refreshCache(raw)
}

/** Decode a load result's source to text; `''` when the hook produced none. */
function toSource(value: LoadResult['source']): string {
  if (typeof value === 'string') {
    return value
  }
  if (!value) {
    return ''
  }
  return Buffer.from(value).toString('utf8')
}

/** Run every active transform over one module source, in order. */
function runTransforms(
  source: string,
  url: string,
  transforms: readonly TransformFn[],
): TransformPass {
  let pass: TransformPass = { source, transformed: false, reports: [] }
  for (const transform of transforms) {
    const output = transform(pass.source, url)
    if (output) {
      pass = {
        source: output.code,
        transformed: true,
        reports: [...pass.reports, ...(output.bindings ?? [])],
      }
    }
  }
  return pass
}

/** Apply the active transforms to one load result. */
function applyTransforms(
  result: LoadResult,
  url: string,
  transforms: readonly TransformFn[],
): LoadResult {
  const pass = runTransforms(toSource(result.source), url, transforms)
  /* The loader thread owns the ESM transform, so the main thread would never
     see these files' bindings; forward them over the shared channel so the
     binding reports and the required-patch check match the sync path. */
  if (pass.reports.length > EMPTY_LENGTH) {
    postToMain(pass.reports)
  }
  if (!pass.transformed) {
    return result
  }
  return { ...result, source: pass.source, shortCircuit: true }
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
  context: Readonly<{ format?: string | null }>,
  nextLoad: (url: string, context: unknown) => Promise<LoadResult>,
): Promise<LoadResult> {
  const result = await nextLoad(url, context)
  if (result.format === 'commonjs') {
    return result
  }
  const transforms = await readTransforms()
  if (transforms.length === EMPTY_LENGTH) {
    return result
  }
  return applyTransforms(result, url, transforms)
}

export { initialize, load }
