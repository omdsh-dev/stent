#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sourceRootFor } from './stent-dsh/cli.ts'
import { parseDshPath } from './stent-dsh/dsh-path.ts'

/** First forwarded argv index: the Node binary and this script come first. */
const FORWARDED_ARGV_START = 2
/** Exit status reported when the child exits without one, e.g. on a signal. */
const EXIT_SUCCESS = 0

interface SpawnPlan {
  readonly stdio: 'inherit'
  cwd?: string
  readonly env: NodeJS.ProcessEnv
}

interface LaunchPlan {
  readonly childArgs: string[]
  readonly childEnv: NodeJS.ProcessEnv
  readonly spawnPlan: SpawnPlan
}

/** Append one `--import` flag per module to the child's NODE_OPTIONS. */
function appendNodeImports(
  existing: string | undefined,
  imports: readonly string[],
): string {
  const flags = imports.map((value) => `--import ${JSON.stringify(value)}`)
  return [existing, ...flags].filter(Boolean).join(' ')
}

/** The preload beside this launcher: the source in a checkout, else the build. */
function preloadPath(): string {
  if (import.meta.url.endsWith('.ts')) {
    return fileURLToPath(new URL('stent-dsh-preload.ts', import.meta.url))
  }
  return fileURLToPath(new URL('stent-dsh-preload.js', import.meta.url))
}

/** Modules the child imports first: tsx only when a TypeScript entry runs. */
function nodeImportsFor(dshPath: string, preload: string): string[] {
  if (dshPath.endsWith('.ts') || preload.endsWith('.ts')) {
    return ['tsx/esm', preload]
  }
  return [preload]
}

/** The child environment, carrying the launch handshake the preload reads. */
function childEnvFor(
  dshPath: string,
  imports: readonly string[],
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: appendNodeImports(process.env.NODE_OPTIONS, imports),
    STENT_DSH_LAUNCH: '1',
    STENT_DSH_PATH: dshPath,
    STENT_LAUNCHER_CWD: process.cwd(),
  }
  delete childEnv.STENT_PRELOAD_DONE
  return childEnv
}

/** Everything the child needs: argv, environment, and spawn options. */
function planLaunch(): LaunchPlan {
  const cwd = pathToFileURL(`${process.cwd()}${path.sep}`)
  const invocation = parseDshPath(
    process.argv.slice(FORWARDED_ARGV_START),
    process.env,
    cwd,
  )
  const dshPath = fileURLToPath(invocation.dshPath)
  const childEnv = childEnvFor(dshPath, nodeImportsFor(dshPath, preloadPath()))
  const childArgs = [dshPath, ...invocation.passthrough]
  const sourceCwd = sourceRootFor(invocation.dshPath)
  const spawnPlan: SpawnPlan = { stdio: 'inherit', env: childEnv }
  if (sourceCwd !== undefined) {
    spawnPlan.cwd = fileURLToPath(sourceCwd)
  }
  return { childArgs, childEnv, spawnPlan }
}

/** Echo the exact child command line before handing the terminal over. */
function announceExec(
  env: Readonly<NodeJS.ProcessEnv>,
  childArgs: readonly string[],
): void {
  const quoted = [process.execPath, ...childArgs].map((value) =>
    JSON.stringify(value),
  )
  process.stderr.write(
    `stent-dsh: exec NODE_OPTIONS=${JSON.stringify(env.NODE_OPTIONS)} ${quoted.join(' ')}\n`,
  )
}

/** Let the child own interactive signals; this process only waits for it. */
function ignoreParentSignals(): void {
  process.on('SIGINT', () => {
    /* The child receives the same signal and decides how to exit. */
  })
  process.on('SIGTERM', () => {
    /* The child receives the same signal and decides how to exit. */
  })
}

/** Run the child CLI to completion and report the status it exited with. */
function runLauncher(): number {
  const plan = planLaunch()
  announceExec(plan.childEnv, plan.childArgs)
  ignoreParentSignals()
  const result = spawnSync(process.execPath, plan.childArgs, plan.spawnPlan)
  if (result.error !== undefined) {
    throw result.error
  }
  return result.status ?? EXIT_SUCCESS
}

process.exitCode = runLauncher()
