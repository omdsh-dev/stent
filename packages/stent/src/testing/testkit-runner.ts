/**
 * Child side of the Stent test kit: reads the fixture payload, installs the
 * dynamic hooks, registers patch metadata, imports the entry module, runs its
 * default export, and writes one JSON envelope to stdout.
 *
 * Runs under `node --import tsx/esm` (see {@link runPatchFixture}); the envelope
 * is the ONLY stdout output, so the parent can parse it verbatim. The child
 * exits 0 for a completed run even when the entry threw (the error travels in
 * the envelope); infrastructure failures (bootstrap error, bad payload) exit
 * non-zero with the reason on stderr.
 *
 * @module @oh-my-dsh/stent/testing/testkit-runner
 */

import { text } from 'node:stream/consumers'

import { flushBindingReports, installStentHooks } from '#src/node/index'
import { runtime } from '#src/runtime'
import type { StentPatchStub } from '#src/types'

/** Exit code for a completed run, even when the fixture entry threw. */
const COMPLETED_EXIT_CODE = 0

/** Exit code for a failure before the envelope could be written. */
const BOOTSTRAP_EXIT_CODE = 1

/** Exit code for a payload this runner cannot use. */
const PAYLOAD_EXIT_CODE = 2

/** Registration priority for a stub that carries none. */
const DEFAULT_PRIORITY = 0

/** The fixture payload from the parent. */
interface FixturePayload {
  readonly patches: readonly StentPatchStub[]
  readonly entry: string
  readonly args?: unknown
}

/** The fixture entry's default export. */
type FixtureEntry = (args: unknown) => unknown

/** One patch's load-time binding records, as the runtime reports them. */
type BindingRecords = ReturnType<typeof runtime.bindingsOf>

/** One entry run's outcome: its resolved value or the thrown error's shape. */
interface EntryOutcome {
  readonly result?: unknown
  readonly error?: { name: string; message: string }
}

/** The JSON envelope written to stdout. */
interface FixtureEnvelope {
  bindings: Record<string, BindingRecords>
  result?: unknown
  error?: { name: string; message: string }
}

/** Format an unknown thrown value for the JSON result envelope. */
function errorDetails(thrown: unknown): { name: string; message: string } {
  if (thrown instanceof Error) {
    return { name: thrown.name, message: thrown.message }
  }
  return { name: 'Error', message: String(thrown) }
}

/** Parse JSON text, or return undefined when it is not valid JSON. */
function parseJson(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw)
    return value
  } catch {
    return undefined
  }
}

/** Whether a parsed payload carries the patches array and entry string. */
function isFixturePayload(value: unknown): value is FixturePayload {
  if (typeof value !== 'object' || !value) {
    return false
  }
  if (!('patches' in value) || !Array.isArray(value.patches)) {
    return false
  }
  return 'entry' in value && typeof value.entry === 'string'
}

/** Read the `default` export of an imported module namespace. */
function readDefault(value: unknown): unknown {
  if (typeof value !== 'object' || !value) {
    return undefined
  }
  if ('default' in value) {
    return value.default
  }
  return undefined
}

/** Whether an entry's default export matches the fixture contract. */
function isFixtureEntry(value: unknown): value is FixtureEntry {
  if (typeof value === 'function') {
    return true
  }
  return false
}

/**
 * Import the fixture entry module and return its default export.
 *
 * @param specifier - Module specifier provided by the parent.
 * @returns The entry's default export.
 * @throws When the module has no default export function.
 */
async function importEntry(specifier: string): Promise<FixtureEntry> {
  /* The entry is a runtime-provided module specifier; its shape is the
     documented default-export function contract. */
  const namespace: unknown = await import(specifier)
  const entry = readDefault(namespace)
  if (!isFixtureEntry(entry)) {
    throw new TypeError(
      `stent testkit: entry ${specifier} has no default export function`,
    )
  }
  return entry
}

/** Run the fixture entry, capturing a thrown error as envelope data. */
async function runEntry(
  entry: FixtureEntry,
  args: unknown,
): Promise<EntryOutcome> {
  try {
    return { result: await entry(args) }
  } catch (error) {
    return { error: errorDetails(error) }
  }
}

const payload = parseJson(await text(process.stdin))
if (payload === undefined) {
  process.stderr.write('stent testkit runner: unparseable payload\n')
  process.exit(PAYLOAD_EXIT_CODE)
}
if (!isFixturePayload(payload)) {
  process.stderr.write(
    'stent testkit runner: payload must carry a patches array and an entry string\n',
  )
  process.exit(PAYLOAD_EXIT_CODE)
}

try {
  installStentHooks()
  for (const patch of payload.patches) {
    runtime.register({
      ...patch,
      priority: patch.priority ?? DEFAULT_PRIORITY,
      enabled: false,
    })
  }
  const outcome = await runEntry(await importEntry(payload.entry), payload.args)
  /* The async hook path delivers binding records over a MessagePort; wait for
     the loader thread's flush reply so every report from the entry's loads has
     landed before the envelope is read (a no-op on the sync path). */
  await flushBindingReports()
  const envelope: FixtureEnvelope = { bindings: {} }
  for (const patch of payload.patches) {
    envelope.bindings[patch.id] = runtime.bindingsOf(patch.id)
  }
  if (outcome.result !== undefined) {
    envelope.result = outcome.result
  }
  if (outcome.error !== undefined) {
    envelope.error = outcome.error
  }
  process.stdout.write(JSON.stringify(envelope))
  process.exit(COMPLETED_EXIT_CODE)
} catch (error) {
  process.stderr.write(`stent testkit runner: ${errorDetails(error).message}\n`)
  process.exit(BOOTSTRAP_EXIT_CODE)
}
