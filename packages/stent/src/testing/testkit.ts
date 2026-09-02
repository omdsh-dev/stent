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

import type { StentBinding, StentPatchStub } from '#src/types'

/** Exit status of a child that completed its run and wrote an envelope. */
const COMPLETED_EXIT_CODE = 0

/** Options for {@link runPatchFixture}. */
interface RunPatchFixtureOptions {
  /** Patch metadata the child registers dynamically before importing the entry. */
  readonly patches: readonly StentPatchStub[]
  /**
   * Module specifier (path or URL) the child imports after bootstrapping; its
   * default export is the async function run with `args`.
   */
  readonly entry: string
  /** Arguments passed to the entry's default export. */
  readonly args?: unknown
  /** Working directory for the child (module resolution base). */
  readonly cwd?: string
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

/** The JSON envelope the child runner writes to stdout. */
interface FixtureEnvelope {
  readonly bindings?: Record<string, StentBinding[]>
  readonly result?: unknown
  readonly error?: { name: string; message: string }
}

/** Resolve the child runner, preferring the built sibling over the source. */
function resolveRunner(): string {
  const built = fileURLToPath(new URL('testkit-runner.js', import.meta.url))
  if (existsSync(built)) {
    return built
  }
  return fileURLToPath(new URL('testkit-runner.ts', import.meta.url))
}

/** Parse JSON text, or return undefined when it is not valid JSON. */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

/* The envelope is written by this package's own runner, so the kit validates
   the JSON container and leaves the field shapes to that contract. */

/** Whether a parsed stdout value is the runner's envelope. */
function isFixtureEnvelope(value: unknown): value is FixtureEnvelope {
  if (typeof value !== 'object' || !value) {
    return false
  }
  return true
}

/**
 * Turn the child's stdout into the fixture outcome.
 *
 * @param stdout - The child's stdout, expected to be one JSON envelope.
 * @param exitCode - The child's exit code.
 * @returns The fixture outcome, or undefined when stdout is not an envelope.
 */
function parseFixtureResult(
  stdout: string,
  exitCode: number,
): PatchFixtureResult | undefined {
  const envelope = parseJson(stdout)
  if (!isFixtureEnvelope(envelope)) {
    return undefined
  }
  const fixtureResult: PatchFixtureResult = {
    bindings: envelope.bindings ?? {},
    exitCode,
  }
  if (envelope.result !== undefined) {
    fixtureResult.result = envelope.result
  }
  if (envelope.error !== undefined) {
    fixtureResult.error = envelope.error
  }
  return fixtureResult
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
  const input = JSON.stringify({
    patches: options.patches,
    entry: options.entry,
    args: options.args,
  })
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', resolveRunner()],
    { input, cwd: options.cwd, encoding: 'utf8', env: { ...process.env } },
  )
  if (child.status !== COMPLETED_EXIT_CODE) {
    throw new Error(
      `stent testkit: child exited ${child.status ?? 'non-zero'} (${child.signal ?? 'no signal'})\n${child.stderr}`,
    )
  }
  const fixtureResult = parseFixtureResult(child.stdout, child.status)
  if (fixtureResult === undefined) {
    throw new Error(
      `stent testkit: child answered no parseable envelope\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
    )
  }
  return fixtureResult
}

export type { RunPatchFixtureOptions, PatchFixtureResult }
export { runPatchFixture }
