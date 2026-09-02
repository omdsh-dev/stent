import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Command } from 'commander'

const EXIT_FAILURE = 1
const NO_ENTRIES = 0

interface LauncherArgs {
  readonly dshPath: URL | undefined
  readonly profile: string | undefined
  readonly dshHome: URL | undefined
  readonly pathEnv: string | undefined
  readonly patchFiles: readonly URL[]
  readonly passthrough: readonly string[]
  readonly launcherUrl: URL
  readonly cwd: URL
}

/* The launcher entry passes these positionally; a tuple rest parameter keeps
   that call shape while staying inside the parameter-count budget. */
type ParseOptInput = [
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  launcherUrl: URL,
  cwd: URL,
  dshPath: URL,
]

type BuildCliArgsInput = [
  args: LauncherArgs,
  effectiveProfile: string | undefined,
  enablePath: URL,
  enableOverlay: readonly unknown[],
]

/** Report launcher guidance on stderr and abort with the documented status. */
function fail(lines: readonly string[]): never {
  for (const line of lines) {
    process.stderr.write(`${line}\n`)
  }
  process.exit(EXIT_FAILURE)
}

/** The profile a run boots: an explicit flag, else the `web` alias. */
function selectedProfile(
  explicit: string | undefined,
  passthrough: readonly string[],
): string | undefined {
  if (explicit !== undefined) {
    return explicit
  }
  const [mode] = passthrough
  if (mode === 'web') {
    return 'web'
  }
  return undefined
}

/** DSH_HOME as a directory URL, when the environment supplies one. */
function dshHomeUrl(dshHome: string | undefined): URL | undefined {
  if (dshHome === undefined) {
    return undefined
  }
  return pathToFileURL(path.resolve(dshHome))
}

/** Parse the launcher-owned flags and keep every other argument untouched. */
function parseOpt(...input: ParseOptInput): LauncherArgs {
  const [argv, env, launcherUrl, cwd, dshPath] = input
  const command = new Command()
    .allowUnknownOption()
    .allowExcessArguments()
    .option('--profile <name>')
    .option(
      '--patch <path>',
      'extra patch overlay',
      (value: string, previous: string[]) => [...previous, value],
    )

  const { operands, unknown } = command.parseOptions([...argv])
  const passthrough = [...operands, ...unknown]
  const cwdPath = fileURLToPath(cwd)
  const options = command.opts<{ profile?: string; patch?: string[] }>()
  return {
    dshPath,
    profile: selectedProfile(options.profile, passthrough),
    dshHome: dshHomeUrl(env.DSH_HOME),
    pathEnv: env.PATH,
    patchFiles: (options.patch ?? []).map((value) =>
      pathToFileURL(path.resolve(cwdPath, value)),
    ),
    passthrough,
    launcherUrl,
    cwd: pathToFileURL(cwdPath + path.sep),
  }
}

/** The `--patch` flags for the overlays this run boots with. */
function patchArguments(
  patchFiles: readonly URL[],
  enablePath: URL,
  enableOverlay: readonly unknown[],
): string[] {
  const patchArgs = patchFiles.flatMap((file) => [
    '--patch',
    fileURLToPath(file),
  ])
  if (enableOverlay.length > NO_ENTRIES) {
    patchArgs.push('--patch', fileURLToPath(enablePath))
  }
  return patchArgs
}

/** The `--profile` flag for the profile this run boots, when there is one. */
function profileArguments(effectiveProfile: string | undefined): string[] {
  if (effectiveProfile === undefined || effectiveProfile === '') {
    return []
  }
  return ['--profile', effectiveProfile]
}

/** `plugin` runs manage patches themselves, so overlays are rejected. */
function pluginArguments(
  passthrough: readonly string[],
  profileArgs: readonly string[],
  patchArgs: readonly string[],
): string[] {
  if (patchArgs.length > NO_ENTRIES) {
    fail([
      'stent-dsh: --patch overlays only apply when booting a profile, not for plugin',
    ])
  }
  return [...passthrough, ...profileArgs]
}

/** `web` boots its own profile, so only overlays may precede the app args. */
function webArguments(
  args: LauncherArgs,
  patchArgs: readonly string[],
): string[] {
  if (args.profile !== undefined && args.profile !== 'web') {
    fail([
      `stent-dsh: \`web\` boots the web profile; drop --profile ${args.profile} or omit the web alias`,
    ])
  }
  /* Web's own --patch must precede the app args (passThroughOptions sends
     everything after the first unknown token to the app). */
  const [, ...appArgs] = args.passthrough
  return ['web', ...patchArgs, ...appArgs]
}

/** Assemble the argv the DSH CLI runs with. */
function buildCliArgs(...input: BuildCliArgsInput): string[] {
  const [args, effectiveProfile, enablePath, enableOverlay] = input
  const [mode] = args.passthrough
  const patchArgs = patchArguments(args.patchFiles, enablePath, enableOverlay)
  const profileArgs = profileArguments(effectiveProfile)
  if (mode === 'plugin') {
    return pluginArguments(args.passthrough, profileArgs, patchArgs)
  }
  if (mode === 'web') {
    return webArguments(args, patchArgs)
  }
  /* Generic boot takes the launcher flags first; the app args only start at
     the first token the launcher does not know. */
  return [...profileArgs, ...patchArgs, ...args.passthrough]
}

export { parseOpt, buildCliArgs }
export type { LauncherArgs }
