#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sep } from 'node:path'
import { parseDshPath } from './stent-dsh/dsh-path.ts'
import { sourceRootFor } from './stent-dsh/cli.ts'

const cwd = pathToFileURL(`${process.cwd()}${sep}`)
const invocation = parseDshPath(process.argv.slice(2), process.env, cwd)
const sourceCwd = sourceRootFor(invocation.dshPath)
const preloadUrl = new URL(
  import.meta.url.endsWith('.ts') ? './stent-dsh-preload.ts' : './stent-dsh-preload.js',
  import.meta.url,
)
const preloadPath = fileURLToPath(preloadUrl)
const childArgs = [fileURLToPath(invocation.dshPath), ...invocation.passthrough]
const nodeImports = [
  ...(fileURLToPath(invocation.dshPath).endsWith('.ts') || preloadPath.endsWith('.ts') ? ['tsx/esm'] : []),
  preloadPath,
]
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_OPTIONS: appendNodeImports(process.env.NODE_OPTIONS, nodeImports),
  STENT_DSH_LAUNCH: '1',
  STENT_DSH_PATH: fileURLToPath(invocation.dshPath),
  STENT_LAUNCHER_CWD: process.cwd(),
}
delete childEnv.STENT_PRELOAD_DONE

process.stderr.write(
  `stent-dsh: exec NODE_OPTIONS=${JSON.stringify(childEnv.NODE_OPTIONS)} ${[process.execPath, ...childArgs]
    .map(value => JSON.stringify(value))
    .join(' ')}\n`,
)

process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
const result = spawnSync(process.execPath, childArgs, {
  stdio: 'inherit',
  ...(sourceCwd === undefined ? {} : { cwd: fileURLToPath(sourceCwd) }),
  env: childEnv,
})
if (result.error !== undefined) throw result.error
process.exit(result.status ?? 0)

function appendNodeImports(existing: string | undefined, imports: readonly string[]): string {
  const flags = imports.map(value => `--import ${JSON.stringify(value)}`)
  const values = existing === undefined ? flags : [existing, ...flags]
  return values.filter(Boolean).join(' ')
}
