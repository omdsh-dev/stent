import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { LauncherArgs } from './args.ts'

interface ResolveOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ResolvedHost {
  source: boolean
  sourceRoot: string | undefined
  bin: string
  realBin: string
  cliPkgJson: string
  fromCli: NodeJS.Require
}

/** Look up an executable on PATH (first hit), tolerating empty segments. */
function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathEnv = env.PATH
  if (pathEnv === undefined || pathEnv === '') return undefined
  const names = process.platform === 'win32' ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd]
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Follow a script shim (pnpm's cmd-shim form) to its target bin file: the
 * trailing `# cmd-shim-target=` marker when present, else the script's
 * `$basedir/...` reference resolved against the shim's own directory.
 */
function shimTarget(shimPath: string): string | undefined {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return undefined
  }
  const marker = text.match(/^# cmd-shim-target=(.+)$/m)
  if (marker !== null && marker[1] !== undefined) return marker[1].trim()
  const rel = text.match(/\$basedir["']?\/(\.\.[^"']*?@deepseek-ai\/dsh\/[^\s"']*?\.js)/)
  if (rel !== null && rel[1] !== undefined) return resolve(dirname(shimPath), rel[1])
  return undefined
}

/**
 * Resolve a shim or entry path toward the package's bin file: symlink shims
 * realpath straight into the package; script shims stay scripts, so their
 * recorded target is followed instead.
 */
function chaseShim(path: string): string {
  const resolved = realpathSync(path)
  if (resolved.endsWith('.js') || (existsSync(resolved) && statSync(resolved).isDirectory())) return resolved
  const target = shimTarget(resolved)
  return target !== undefined && existsSync(target) ? realpathSync(target) : resolved
}

/**
 * Normalize a user-supplied or shim-resolved path to the package's lib/bin.js:
 * accepts the bin file, the package root, or anything inside the package.
 */
function normalizeCli(path: string): string | undefined {
  let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path)
  for (let i = 0; i < 5; i++) {
    const pkgJson = join(dir, 'package.json')
    if (existsSync(pkgJson)) {
      try {
        const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as unknown as { name?: unknown }
        if (manifest.name === '@deepseek-ai/dsh') {
          const candidate = join(dir, 'lib/bin.js')
          if (existsSync(candidate)) return candidate
        }
      } catch {
        // unparsable manifest: keep walking up
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Resolve a registry-installed @deepseek-ai/dsh from DSH_CLI, the caller's
 * project dependencies, or a `dsh` on PATH. Shims are followed to the real
 * package file: pnpm store layouts resolve a package's declared deps only
 * from its real location.
 */
function resolveInstalledCli({ cwd = process.cwd(), env = process.env }: ResolveOptions = {}): string {
  const explicit = env.DSH_CLI
  if (explicit !== undefined) {
    const cli = normalizeCli(chaseShim(resolve(explicit)))
    if (cli !== undefined) return cli
    console.error(`stent-dsh: DSH_CLI=${explicit} does not lead to an @deepseek-ai/dsh package (expected .../@deepseek-ai/dsh/lib/bin.js)`)
    process.exit(1)
  }
  try {
    const pkgJson = createRequire(join(cwd, 'package.json')).resolve('@deepseek-ai/dsh/package.json')
    const candidate = join(dirname(pkgJson), 'lib/bin.js')
    if (existsSync(candidate)) return realpathSync(candidate)
  } catch {
    // not a project dependency of the caller's cwd
  }
  const onPath = which('dsh', env)
  if (onPath !== undefined) {
    try {
      const cli = normalizeCli(chaseShim(onPath))
      if (cli !== undefined) return cli
    } catch {
      // shim did not lead to the package
    }
  }
  console.error('stent-dsh: no --source given and no installed @deepseek-ai/dsh found')
  console.error('  run from a project with @deepseek-ai/dsh installed, put dsh on PATH, or set DSH_CLI to its package bin')
  console.error('  (to run a source checkout instead, pass --source <deepseek-harness-checkout>)')
  process.exit(1)
}

/** Resolve either the source checkout entry or the published CLI entry. */
export function resolveHost(args: LauncherArgs, { cwd = process.cwd(), env = process.env }: ResolveOptions = {}): ResolvedHost {
  const sourceRoot = args.source === undefined ? undefined : resolve(args.source)
  const source = sourceRoot !== undefined
  const bin = sourceRoot === undefined
    ? resolveInstalledCli({ cwd, env })
    : join(sourceRoot, 'apps/cli/src/bin.ts')
  if (sourceRoot !== undefined && !existsSync(bin)) {
    console.error(`stent-dsh: no CLI entry at ${bin} (source: ${args.source})`)
    process.exit(1)
  }
  const realBin = realpathSync(bin)
  const cliPkgJson = join(dirname(dirname(realBin)), 'package.json')
  const fromCli = createRequire(realBin)
  return { source, sourceRoot, bin, realBin, cliPkgJson, fromCli }
}
