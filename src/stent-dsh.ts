#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { constants } from 'node:os'

import { Command } from 'commander'

const EXIT_FAILURE = 1
const SIGNAL_EXIT_BASE = 128

function main(): number {
  // Signal handling stays empty so the child controls exit ordering.
  process.on('SIGINT', () => {
    // The child process owns signal handling.
  })
  process.on('SIGTERM', () => {
    // The child process owns signal handling.
  })

  const command = new Command()
    .allowUnknownOption()
    .allowExcessArguments()
    .option('--dsh <path>', 'dsh cmd or source path', 'dsh')

  command.parse()
  const { dsh } = command.opts<{ dsh: string }>()
  let dsh_cmd = dsh
  let { args } = command

  // A directory selects a checkout command instead of a PATH executable.
  const stats = fs.statSync(dsh, { throwIfNoEntry: false })
  if (stats !== undefined && stats.isDirectory()) {
    dsh_cmd = 'pnpm'
    args = ['run', '--dir', dsh, 'dsh', ...args]
  }

  let stent_loader_file = './stent-loader.js'
  if (import.meta.url.endsWith('.ts')) {
    stent_loader_file = './stent-loader.ts'
  }
  const stent_loader = new URL(stent_loader_file, import.meta.url)
  // The href is already a string; it needs no extra JSON quoting.
  const loaderImport = `--import ${stent_loader.href}`

  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, loaderImport]
      .filter(Boolean)
      .join(' '),
  }

  const result = spawnSync(dsh_cmd, args, { stdio: 'inherit', env })
  if (result.error !== undefined) {
    process.stderr.write(
      `stent-dsh: cannot execute ${dsh_cmd}: ${result.error.message}\n`,
    )
    return EXIT_FAILURE
  }
  if (result.signal !== null) {
    return SIGNAL_EXIT_BASE + constants.signals[result.signal]
  }
  return result.status ?? EXIT_FAILURE
}

process.exitCode = main()
