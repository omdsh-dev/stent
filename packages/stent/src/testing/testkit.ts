/**
 * Test kit for Stent patch fixtures: run one patch scenario in a fresh child
 * process and report the outcome plus the load-time binding records.
 *
 * The transformation hooks cannot be unregistered and transformed modules stay
 * cached, so every scenario needs a clean process. This kit makes that
 * mechanical: `runPatchFixture` spawns a child that registers the given patch
 * metadata, imports the entry module, runs its default export with the given
 * args, and returns the resolved result (or the thrown error's shape) with the
 * per-patch binding records — the same shape a hand-rolled child runner would
 * produce, without the per-package boilerplate.
 *
 * The kit is test-only: it spawns the child through tsx, imports the package's
 * source entry (the `./src/*` export), and is itself imported through that same
 * export in repository tests.
 *
 * @module @oh-my-dsh/stent/testing/testkit
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { StentBinding, StentPatchStub } from '../types.ts'

/** Options for {@link runPatchFixture}. */
interface RunPatchFixtureOptions {
  /** Patch metadata the child registers dynamically before importing the entry. */
  patches: StentPatchStub[]
  /**
   * Module specifier (path or URL) the child imports after bootstrapping; its
   * default export is the async function run with `args`.
   */
  entry: string
  /** Arguments passed to the entry's default export. */
  args?: unknown
  /** Working directory for the child (module resolution base). */
  cwd?: string
}

/** One fixture run's outcome: bindings, result or error, and exit code. */
interface PatchFixtureResult {
  /** Load-time bindings recorded per patch id in the child. */
  bindings: Record<string, StentBinding[]>
  /** The entry's resolved return value, when it returned. */
  result?: unknown
  /** The thrown error's name and message, when the entry threw. */
  error?: { name: string; message: string }
  /** Child exit code (0 for a completed run, even when the entry threw). */
  exitCode: number
}

/**
 * Run one patch fixture in a fresh child process.
 *
 * The child bootstraps the patches, imports `entry`, and awaits its default
 * export with `args`; the envelope reports the resolved result or the thrown
 * error's name/message plus the load-time bindings each patch recorded (a patch
 * that bound nothing is immediately visible). A child that fails before the
 * envelope (bootstrap error, unparseable payload) throws with the child's
 * stderr.
 *
 * @param options - Patches, entry, args, and optional child cwd.
 * @returns The fixture outcome.
 * @throws When the child process fails or answers no parseable envelope.
 */
function runPatchFixture(options: RunPatchFixtureOptions): PatchFixtureResult {
  const runner = fileURLToPath(
    new URL(
      existsSync(fileURLToPath(new URL('./testkit-runner.js', import.meta.url)))
        ? './testkit-runner.js'
        : './testkit-runner.ts',
      import.meta.url,
    ),
  )
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', runner], {
    input: JSON.stringify({
      patches: options.patches,
      entry: options.entry,
      args: options.args,
    }),
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env },
  })
  if (result.status !== 0) {
    throw new Error(
      `stent testkit: child exited ${result.status ?? 'non-zero'} (${result.signal ?? 'no signal'})\n${result.stderr}`,
    )
  }
  let envelope: {
    bindings?: Record<string, StentBinding[]>
    result?: unknown
    error?: { name: string; message: string }
  }
  try {
    envelope = JSON.parse(result.stdout) as typeof envelope
  } catch {
    throw new Error(
      `stent testkit: child answered no parseable envelope\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
  return {
    bindings: envelope.bindings ?? {},
    ...(envelope.result === undefined ? {} : { result: envelope.result }),
    ...(envelope.error === undefined ? {} : { error: envelope.error }),
    exitCode: result.status,
  }
}

export type { RunPatchFixtureOptions, PatchFixtureResult }
export { runPatchFixture }
