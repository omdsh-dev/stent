import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { LauncherArgs } from './args.ts'

const EXIT_FAILURE = 1
const ONE_LEVEL = 1
const MAX_PACKAGE_DEPTH = 5
const CMD_SHIM_TARGET = /^# cmd-shim-target=(?<target>.+)$/mu
const BASEDIR_TARGET =
  /\$basedir["']?\/(?<target>\.\.[^"']*?@deepseek-ai\/dsh\/[^\s"']*?\.js)/u

type DirectoryMatcher = (dir: string) => boolean

interface ResolveOptions {
  readonly dshPath: LauncherArgs['dshPath']
  readonly pathEnv: LauncherArgs['pathEnv']
  readonly cwd: LauncherArgs['cwd']
}

interface ResolvedHost {
  readonly cliPkgJson: URL
  readonly fromCli: NodeJS.Require
  readonly cwd: URL | undefined
}

/** Report launcher guidance on stderr and abort with the documented status. */
function fail(lines: readonly string[]): never {
  for (const line of lines) {
    process.stderr.write(`${line}\n`)
  }
  process.exit(EXIT_FAILURE)
}

/** Look up an executable on PATH (first hit), tolerating empty segments. */
function which(cmd: string, pathEnv: string | undefined): URL | undefined {
  if (pathEnv === undefined || pathEnv === '') {
    return undefined
  }
  const names = [cmd]
  if (process.platform === 'win32') {
    names.unshift(`${cmd}.cmd`, `${cmd}.exe`)
  }
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir !== '')
  const candidates = dirs.flatMap((dir) =>
    names.map((name) => pathToFileURL(path.join(dir, name))),
  )
  return candidates.find((candidate) => existsSync(candidate))
}

/** The bin path a script shim records, as a marker or a `$basedir` reference. */
function shimReference(shimPath: URL): string | undefined {
  try {
    const text = readFileSync(shimPath, 'utf8')
    const marker = CMD_SHIM_TARGET.exec(text)?.groups?.target
    if (marker !== undefined) {
      return marker.trim()
    }
    return BASEDIR_TARGET.exec(text)?.groups?.target
  } catch {
    return undefined
  }
}

/**
 * Follow a script shim (pnpm's cmd-shim form) to the bin file it records,
 * resolved against the shim's own directory.
 */
function shimTarget(shimPath: URL): URL | undefined {
  const reference = shimReference(shimPath)
  if (reference === undefined) {
    return undefined
  }
  const shimDir = path.dirname(fileURLToPath(shimPath))
  return pathToFileURL(path.resolve(shimDir, reference))
}

/**
 * Resolve a shim toward the package's bin file: symlink shims realpath into the
 * package; script shims stay scripts, so their target is followed.
 */
function chaseShim(entry: URL): URL {
  const resolved = pathToFileURL(realpathSync(entry))
  if (
    fileURLToPath(resolved).endsWith('.js')
    || (existsSync(resolved) && statSync(resolved).isDirectory())
  ) {
    return resolved
  }
  const target = shimTarget(resolved)
  if (target !== undefined && existsSync(target)) {
    return pathToFileURL(realpathSync(target))
  }
  return resolved
}

/** Whether `dir` holds the installed DSH package and its bin file. */
function isDshPackage(dir: string): boolean {
  const manifestPath = path.join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    return false
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (
      typeof manifest === 'object'
      && manifest !== null
      && 'name' in manifest
      && manifest.name === '@deepseek-ai/dsh'
    ) {
      return existsSync(path.join(dir, 'lib/bin.js'))
    }
  } catch {
    /* Unparsable manifest: keep walking up. */
  }
  return false
}

/** Probe a directory and its parents, stopping at the first match. */
function walkUp(from: string, matches: DirectoryMatcher): string | undefined {
  let dir = from
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH; depth += ONE_LEVEL) {
    if (matches(dir)) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
  return undefined
}

/** Normalize a bin file, package root, or inner path to lib/bin.js. */
function normalizeCli(entry: URL): URL | undefined {
  const entryPath = fileURLToPath(entry)
  let start = path.dirname(entryPath)
  if (existsSync(entry) && statSync(entry).isDirectory()) {
    start = entryPath
  }
  const root = walkUp(start, isDshPackage)
  if (root === undefined) {
    return undefined
  }
  return pathToFileURL(path.join(root, 'lib/bin.js'))
}

/** Resolve @deepseek-ai/dsh from the caller's own project dependencies. */
function requireResolvedCli(cwd: URL): URL | undefined {
  try {
    const fromCwd = createRequire(new URL('package.json', cwd))
    const manifestPath = fromCwd.resolve('@deepseek-ai/dsh/package.json')
    const binPath = path.join(path.dirname(manifestPath), 'lib/bin.js')
    const candidate = pathToFileURL(binPath)
    if (existsSync(candidate)) {
      return pathToFileURL(realpathSync(candidate))
    }
  } catch {
    /* Not a project dependency of the caller's cwd. */
  }
  return undefined
}

/** Resolve @deepseek-ai/dsh from a `dsh` shim found on PATH. */
function pathResolvedCli(pathEnv: string | undefined): URL | undefined {
  const onPath = which('dsh', pathEnv)
  if (onPath === undefined) {
    return undefined
  }
  try {
    return normalizeCli(chaseShim(onPath))
  } catch {
    /* Shim did not lead to the package. */
    return undefined
  }
}

/** Resolve an installed @deepseek-ai/dsh from the caller's project or PATH. */
function resolveInstalledCli(cwd: URL, pathEnv: string | undefined): URL {
  const fromProject = requireResolvedCli(cwd)
  if (fromProject !== undefined) {
    return fromProject
  }
  const fromPath = pathResolvedCli(pathEnv)
  if (fromPath !== undefined) {
    return fromPath
  }
  return fail([
    'stent-dsh: no DSH path was supplied and no installed @deepseek-ai/dsh was found',
    '  pass --dsh-path <source checkout, package, or bin> or put dsh on PATH',
  ])
}

/** Resolve a directory to its source bin or its installed package bin. */
function resolveDirectoryCli(input: URL): URL | undefined {
  const sourcePath = path.join(fileURLToPath(input), 'apps/cli/src/bin.ts')
  const sourceBin = pathToFileURL(sourcePath)
  if (existsSync(sourceBin)) {
    return pathToFileURL(realpathSync(sourceBin))
  }
  const installedBin = normalizeCli(input)
  if (installedBin !== undefined) {
    return pathToFileURL(realpathSync(installedBin))
  }
  return undefined
}

/** Resolve an existing path to the DSH entry it stands for. */
function resolveExistingDshPath(input: URL): URL {
  if (statSync(input).isDirectory()) {
    const fromDirectory = resolveDirectoryCli(input)
    if (fromDirectory !== undefined) {
      return fromDirectory
    }
  }
  if (fileURLToPath(input).endsWith('.ts')) {
    return pathToFileURL(realpathSync(input))
  }
  const installedBin = normalizeCli(chaseShim(input))
  if (installedBin !== undefined) {
    return pathToFileURL(realpathSync(installedBin))
  }
  return fail([
    `stent-dsh: cannot resolve a DSH CLI from path: ${fileURLToPath(input)}`,
    '  expected a source checkout, @deepseek-ai/dsh package, or bin file',
  ])
}

/** Resolve a source checkout, package directory, bin file, or PATH command. */
function resolveDshPath(
  input: URL | undefined,
  cwd: URL,
  pathEnv: string | undefined,
): URL {
  if (input === undefined) {
    return resolveInstalledCli(cwd, pathEnv)
  }
  if (!existsSync(input)) {
    return fail([`stent-dsh: DSH path does not exist: ${fileURLToPath(input)}`])
  }
  return resolveExistingDshPath(input)
}

/** The source checkout root a TypeScript DSH entry belongs to. */
function sourceRootFor(bin: URL): URL | undefined {
  const binPath = fileURLToPath(bin)
  if (!binPath.endsWith('.ts')) {
    return undefined
  }
  const root = walkUp(path.dirname(binPath), (dir) =>
    existsSync(path.join(dir, 'apps/cli/src/bin.ts')),
  )
  if (root === undefined) {
    return undefined
  }
  return pathToFileURL(root + path.sep)
}

/** The CLI manifest that anchors the module fallback for this DSH entry. */
function cliPackageJsonFor(realBin: URL, sourceRoot: URL | undefined): URL {
  if (sourceRoot !== undefined) {
    return new URL('apps/cli/package.json', sourceRoot)
  }
  const binDir = path.dirname(fileURLToPath(realBin))
  return pathToFileURL(path.join(path.dirname(binDir), 'package.json'))
}

/** Resolve the final DSH entry and the Node settings needed to run it. */
function resolveHost({ dshPath, pathEnv, cwd }: ResolveOptions): ResolvedHost {
  const resolvedDshPath = resolveDshPath(dshPath, cwd, pathEnv)
  const realBin = pathToFileURL(realpathSync(resolvedDshPath))
  const sourceRoot = sourceRootFor(realBin)
  if (fileURLToPath(realBin).endsWith('.ts') && sourceRoot === undefined) {
    fail([
      `stent-dsh: TypeScript DSH entry is not inside a source checkout: ${fileURLToPath(resolvedDshPath)}`,
    ])
  }
  return {
    cliPkgJson: cliPackageJsonFor(realBin, sourceRoot),
    fromCli: createRequire(realBin),
    cwd: sourceRoot,
  }
}

export { resolveDshPath, sourceRootFor, resolveHost }
