import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveDshPath } from './cli.ts'

const EXIT_FAILURE = 1
const DSH_PATH_FLAG = '--dsh-path'
const DSH_PATH_INLINE = '--dsh-path='
const FIRST_INDEX = 0
const ONE_TOKEN = 1
const NO_TOKENS = 0
const LAST_INDEX = -1

interface DshInvocation {
  readonly dshPath: URL
  readonly passthrough: readonly string[]
}

interface TokenOutcome {
  /** The DSH path this token selects, when it is the launcher's own flag. */
  readonly value?: string
  /** The token to forward to DSH, when the launcher does not own it. */
  readonly keep?: string
  /** How many following tokens the flag already consumed. */
  readonly skip: number
}

interface DshPathScan {
  readonly input: string | undefined
  readonly passthrough: string[]
}

/** Report launcher guidance on stderr and abort with the documented status. */
function fail(lines: readonly string[]): never {
  for (const line of lines) {
    process.stderr.write(`${line}\n`)
  }
  process.exit(EXIT_FAILURE)
}

/** Reject an absent or empty DSH path selection. */
function requireFlagValue(value: string | undefined): string {
  if (value === undefined || value === '') {
    fail(['stent-dsh: --dsh-path requires a value'])
  }
  return value
}

/** Classify one argv token as the launcher's DSH path flag or a DSH argument. */
function classifyToken(token: string, next: string | undefined): TokenOutcome {
  if (token === DSH_PATH_FLAG) {
    return { value: requireFlagValue(next), skip: ONE_TOKEN }
  }
  if (token.startsWith(DSH_PATH_INLINE)) {
    const inline = token.slice(DSH_PATH_INLINE.length)
    return { value: requireFlagValue(inline), skip: NO_TOKENS }
  }
  return { keep: token, skip: NO_TOKENS }
}

/** Record one classified token in the launcher and passthrough collections. */
function collectToken(
  outcome: TokenOutcome,
  values: string[],
  passthrough: string[],
): void {
  if (outcome.value !== undefined) {
    values.push(outcome.value)
  }
  if (outcome.keep !== undefined) {
    passthrough.push(outcome.keep)
  }
}

/** Split argv into the last DSH path selection and every other argument. */
function scanArgv(argv: readonly string[]): DshPathScan {
  const values: string[] = []
  const passthrough: string[] = []
  let index = FIRST_INDEX
  while (index < argv.length) {
    const outcome = classifyToken(argv[index] ?? '', argv[index + ONE_TOKEN])
    collectToken(outcome, values, passthrough)
    index += ONE_TOKEN + outcome.skip
  }
  return { input: values.at(LAST_INDEX), passthrough }
}

/** The executable file names a command can take on this platform. */
function commandFileNames(cmd: string): readonly string[] {
  if (process.platform === 'win32') {
    return [`${cmd}.cmd`, `${cmd}.exe`, cmd]
  }
  return [cmd]
}

/** Look up an executable on PATH (first hit), tolerating empty segments. */
function which(cmd: string, pathEnv: string | undefined): URL | undefined {
  if (pathEnv === undefined || pathEnv === '') {
    return undefined
  }
  const names = commandFileNames(cmd)
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir !== '')
  for (const dir of dirs) {
    const candidates = names.map((name) => pathToFileURL(path.join(dir, name)))
    const hit = candidates.find((candidate) => existsSync(candidate))
    if (hit !== undefined) {
      return hit
    }
  }
  return undefined
}

/** Turn a bare command name into its PATH entry, or a path into its URL. */
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
  return pathToFileURL(path.resolve(fileURLToPath(cwd), input))
}

/**
 * Parse only the launcher-owned DSH path and leave every other argument
 * untouched.
 */
function parseDshPath(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: URL,
): DshInvocation {
  const scan = scanArgv(argv)
  const input = resolveDshInput(scan.input, env.PATH, cwd)
  return {
    dshPath: resolveDshPath(input, cwd, env.PATH),
    passthrough: scan.passthrough,
  }
}

export { parseDshPath }
