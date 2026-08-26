/**
 * Child side of the Stent test kit: reads the fixture payload, installs the
 * dynamic hooks, registers patch metadata, imports the entry module, runs its default export, and writes
 * one JSON envelope to stdout.
 *
 * Runs under `node --import tsx/esm` (see {@link runPatchFixture}); the
 * envelope is the ONLY stdout output, so the parent can parse it verbatim.
 * The child exits 0 for a completed run even when the entry threw (the
 * error travels in the envelope); infrastructure failures (bootstrap error,
 * bad payload) exit non-zero with the reason on stderr.
 * @module @oh-my-dsh/stent/testing/testkit-runner
 */

import { flushBindingReports, installStentHooks } from '../node/index.ts'
import { runtime } from '../runtime.ts'
import type { StentPatchStub } from '../types.ts'

/** Read the whole stdin stream. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
    })
    process.stdin.on('end', () => {
      resolve(data)
    })
    process.stdin.on('error', reject)
  })
}

/** The fixture payload from the parent. */
interface FixturePayload {
  patches?: StentPatchStub[]
  entry?: string
  args?: unknown
}

const raw = await readStdin()
let payload: FixturePayload
try {
  payload = JSON.parse(raw) as FixturePayload
} catch {
  console.error('stent testkit runner: unparseable payload')
  process.exit(2)
}
if (!Array.isArray(payload.patches) || typeof payload.entry !== 'string') {
  console.error('stent testkit runner: payload must carry a patches array and an entry string')
  process.exit(2)
}

try {
  installStentHooks()
  for (const patch of payload.patches) {
    runtime.register({
      ...patch,
      priority: patch.priority ?? 0,
      enabled: false,
    })
  }
  // The entry is a runtime-provided module specifier; its shape is the
  // documented default-export function contract.
  const mod = (await import(payload.entry)) as { default?: unknown }
  const fn = mod.default
  if (typeof fn !== 'function') {
    throw new Error(`stent testkit: entry ${payload.entry} has no default export function`)
  }
  let result: unknown
  let error: { name: string; message: string } | undefined
  try {
    result = await (fn as (args: unknown) => unknown)(payload.args)
  } catch (thrown) {
    error = {
      name: thrown instanceof Error ? thrown.name : 'Error',
      message: thrown instanceof Error ? thrown.message : String(thrown),
    }
  }
  // The async hook path delivers binding records over a MessagePort; wait for
  // the loader thread's flush reply so every report from the entry's loads has
  // landed before the envelope is read (a no-op on the sync path).
  await flushBindingReports()
  const bindings: Record<string, ReturnType<typeof runtime.bindingsOf>> = {}
  for (const patch of payload.patches) bindings[patch.id] = runtime.bindingsOf(patch.id)
  process.stdout.write(
    JSON.stringify({
      bindings,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    }),
  )
  process.exit(0)
} catch (error) {
  console.error(`stent testkit runner: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
