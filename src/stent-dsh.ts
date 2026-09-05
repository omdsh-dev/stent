#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import url from 'node:url'

import { Command } from 'commander'

const EXIT_SUCCESS = 0

function main(): number {
  // 线程配置:信号处理置空以保证退出顺序
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

  const stats = fs.statSync(dsh, { throwIfNoEntry: false }) // 此处是为了处理命令
  if (stats !== undefined && stats.isDirectory()) {
    dsh_cmd = 'pnpm'
    args = ['run', '--dir', dsh, 'dsh', ...args]
  }

  let stent_loader_file = './stent-loader.js'
  if (import.meta.url.endsWith('.ts')) {
    stent_loader_file = './stent-loader.ts'
  }
  const stent_loader = new URL(stent_loader_file, import.meta.url)
  const stent_loader_path = url.fileURLToPath(stent_loader)

  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import "${stent_loader_path}"`]
      .filter(Boolean)
      .join(' '),
  }

  const result = spawnSync(dsh_cmd, args, { stdio: 'inherit', env })
  return result.status ?? EXIT_SUCCESS
}

process.exitCode = main()
