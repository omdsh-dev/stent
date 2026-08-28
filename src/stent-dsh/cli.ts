import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { LauncherArgs } from './args.ts'

interface ResolveOptions {
  dshPath: LauncherArgs['dshPath']
  pathEnv: LauncherArgs['pathEnv']
  cwd: LauncherArgs['cwd']
}

interface ResolvedHost {
  cliPkgJson: URL
  fromCli: NodeJS.Require
  cwd: URL | undefined
}

/** Look up an executable on PATH (first hit), tolerating empty segments. */
function which(cmd: string, pathEnv: string | undefined): URL | undefined {
  if (pathEnv === undefined || pathEnv === '') {
    return undefined
  }
  const names =
    process.platform === 'win32' ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd]
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

/**
 * Follow a script shim (pnpm's cmd-shim form) to its target bin file: the
 * trailing `# cmd-shim-target=` marker when present, else the script's
 * `$basedir/...` reference resolved against the shim's own directory.
 */
function shimTarget(shimPath: URL): URL | undefined {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return undefined
  }
  const marker = text.match(/^# cmd-shim-target=(.+)$/m)
  if (marker !== null && marker[1] !== undefined) {
    return pathToFileURL(
      resolve(dirname(fileURLToPath(shimPath)), marker[1].trim()),
    )
  }
  const rel = text.match(
    /\$basedir["']?\/(\.\.[^"']*?@deepseek-ai\/dsh\/[^\s"']*?\.js)/,
  )
  if (rel !== null && rel[1] !== undefined) {
    return pathToFileURL(resolve(dirname(fileURLToPath(shimPath)), rel[1]))
  }
  return undefined
}

/**
 * Resolve a shim or entry path toward the package's bin file: symlink shims
 * realpath straight into the package; script shims stay scripts, so their
 * recorded target is followed instead.
 */
function chaseShim(path: URL): URL {
  const resolved = pathToFileURL(realpathSync(path))
  if (
    fileURLToPath(resolved).endsWith('.js')
    || (existsSync(resolved) && statSync(resolved).isDirectory())
  ) {
    return resolved
  }
  const target = shimTarget(resolved)
  return target !== undefined && existsSync(target)
    ? pathToFileURL(realpathSync(target))
    : resolved
}

/**
 * Normalize a user-supplied or shim-resolved path to the package's lib/bin.js:
 * accepts the bin file, the package root, or anything inside the package.
 */
function normalizeCli(path: URL): URL | undefined {
  let dir =
    existsSync(path) && statSync(path).isDirectory()
      ? fileURLToPath(path)
      : dirname(fileURLToPath(path))
  for (let i = 0; i < 5; i++) {
    const pkgJson = join(dir, 'package.json')
    if (existsSync(pkgJson)) {
      try {
        const manifest = JSON.parse(
          readFileSync(pkgJson, 'utf8'),
        ) as unknown as { name?: unknown }
        if (manifest.name === '@deepseek-ai/dsh') {
          const candidate = join(dir, 'lib/bin.js')
          if (existsSync(candidate)) {
            return pathToFileURL(candidate)
          }
        }
      } catch {
        // unparsable manifest: keep walking up
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}

/**
 * Resolve a registry-installed @deepseek-ai/dsh from the caller's project or
 * PATH.
 */
function resolveInstalledCli(cwd: URL, pathEnv: string | undefined): URL {
  try {
    const pkgJson = createRequire(new URL('package.json', cwd)).resolve(
      '@deepseek-ai/dsh/package.json',
    )
    const candidate = pathToFileURL(join(dirname(pkgJson), 'lib/bin.js'))
    if (existsSync(candidate)) {
      return pathToFileURL(realpathSync(candidate))
    }
  } catch {
    // not a project dependency of the caller's cwd
  }
  const onPath = which('dsh', pathEnv)
  if (onPath !== undefined) {
    try {
      const cli = normalizeCli(chaseShim(onPath))
      if (cli !== undefined) {
        return cli
      }
    } catch {
      // shim did not lead to the package
    }
  }
  console.error(
    'stent-dsh: no DSH path was supplied and no installed @deepseek-ai/dsh was found',
  )
  console.error(
    '  pass --dsh-path <source checkout, package, or bin> or put dsh on PATH',
  )
  process.exit(1)
}

/** Resolve a source checkout, package directory, bin file, or PATH command. */
export function resolveDshPath(
  input: URL | undefined,
  cwd: URL,
  pathEnv: string | undefined,
): URL {
  if (input === undefined) {
    return resolveInstalledCli(cwd, pathEnv)
  }
  if (!existsSync(input)) {
    console.error(`stent-dsh: DSH path does not exist: ${fileURLToPath(input)}`)
    process.exit(1)
  }
  if (statSync(input).isDirectory()) {
    const sourceBin = pathToFileURL(
      join(fileURLToPath(input), 'apps/cli/src/bin.ts'),
    )
    if (existsSync(sourceBin)) {
      return pathToFileURL(realpathSync(sourceBin))
    }
    const installedBin = normalizeCli(input)
    if (installedBin !== undefined) {
      return pathToFileURL(realpathSync(installedBin))
    }
  }
  if (fileURLToPath(input).endsWith('.ts')) {
    return pathToFileURL(realpathSync(input))
  }
  const installedBin = normalizeCli(chaseShim(input))
  if (installedBin !== undefined) {
    return pathToFileURL(realpathSync(installedBin))
  }
  console.error(
    `stent-dsh: cannot resolve a DSH CLI from path: ${fileURLToPath(input)}`,
  )
  console.error(
    '  expected a source checkout, @deepseek-ai/dsh package, or bin file',
  )
  process.exit(1)
}

export function sourceRootFor(bin: URL): URL | undefined {
  const binPath = fileURLToPath(bin)
  if (!binPath.endsWith('.ts')) {
    return undefined
  }
  let dir = dirname(binPath)
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'apps/cli/src/bin.ts'))) {
      return pathToFileURL(dir + sep)
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}

/** Resolve the final DSH entry and the Node settings needed to run it. */
export function resolveHost({
  dshPath,
  pathEnv,
  cwd,
}: ResolveOptions): ResolvedHost {
  const resolvedDshPath = resolveDshPath(dshPath, cwd, pathEnv)
  const realBin = pathToFileURL(realpathSync(resolvedDshPath))
  const sourceRoot = sourceRootFor(realBin)
  if (fileURLToPath(realBin).endsWith('.ts') && sourceRoot === undefined) {
    console.error(
      `stent-dsh: TypeScript DSH entry is not inside a source checkout: ${fileURLToPath(resolvedDshPath)}`,
    )
    process.exit(1)
  }
  const cliPkgJson =
    sourceRoot === undefined
      ? pathToFileURL(
          join(dirname(dirname(fileURLToPath(realBin))), 'package.json'),
        )
      : new URL('apps/cli/package.json', sourceRoot)
  const fromCli = createRequire(realBin)
  return {
    cliPkgJson,
    fromCli,
    cwd: sourceRoot,
  }
}
