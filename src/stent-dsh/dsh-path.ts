import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { URL } from 'node:url'

import { resolveDshPath } from './cli.ts'

interface DshInvocation {
  dshPath: URL
  passthrough: string[]
}

/**
 * Parse only the launcher-owned DSH path and leave every other argument
 * untouched.
 */
function parseDshPath(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: URL,
): DshInvocation {
  let input: string | undefined
  const passthrough: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--dsh-path') {
      const next = argv[++index]
      if (next === undefined || next === '') {
        console.error('stent-dsh: --dsh-path requires a value')
        process.exit(1)
      }
      input = next
      continue
    }
    if (value !== undefined && value.startsWith('--dsh-path=')) {
      input = value.slice('--dsh-path='.length)
      if (input === '') {
        console.error('stent-dsh: --dsh-path requires a value')
        process.exit(1)
      }
      continue
    }
    if (value !== undefined) {
      passthrough.push(value)
    }
  }

  return {
    dshPath: resolveDshPath(
      resolveDshInput(input, env.PATH, cwd),
      cwd,
      env.PATH,
    ),
    passthrough,
  }
}

function resolveDshInput(
  input: string | undefined,
  pathEnv: string | undefined,
  cwd: URL,
): URL | undefined {
  if (input === undefined || input === '') {
    return undefined
  }
  if (!input.includes('/') && !input.includes('\\')) {
    const command = which(input, pathEnv)
    if (command !== undefined) {
      return command
    }
  }
  return pathToFileURL(resolve(fileURLToPath(cwd), input))
}

function which(cmd: string, pathEnv: string | undefined): URL | undefined {
  if (pathEnv === undefined || pathEnv === '') {
    return undefined
  }
  let names: string[]
  if (process.platform === 'win32') {
    names = [`${cmd}.cmd`, `${cmd}.exe`, cmd]
  } else {
    names = [cmd]
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') {
      continue
    }
    for (const name of names) {
      const candidate = pathToFileURL(join(dir, name))
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

export { parseDshPath }
