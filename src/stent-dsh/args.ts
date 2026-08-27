import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Command } from 'commander'

export interface LauncherArgs {
  dshPath: URL | undefined
  profile: string | undefined
  dshHome: URL | undefined
  pathEnv: string | undefined
  env: NodeJS.ProcessEnv
  patchFiles: URL[]
  passthrough: string[]
  launcherUrl: URL
  cwd: URL
}

export function parseOpt(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  launcherUrl: URL,
  cwd: URL,
  dshPath: URL,
): LauncherArgs {
  const command = new Command()
    .allowUnknownOption()
    .allowExcessArguments()
    .option('--profile <name>')
    .option('--patch <path>', 'extra patch overlay', collect)

  const { operands, unknown } = command.parseOptions([...argv])
  const passthrough = [...operands, ...unknown]
  const cwdPath = fileURLToPath(cwd)
  const cwdUrl = pathToFileURL(cwdPath + sep)
  const options = command.opts<{ profile?: string; patch?: string[] }>()
  return {
    dshPath,
    profile: options.profile ?? (passthrough[0] === 'web' ? 'web' : undefined),
    dshHome: env.DSH_HOME === undefined ? undefined : pathToFileURL(resolve(env.DSH_HOME)),
    pathEnv: env.PATH,
    env: { ...env },
    patchFiles: (options.patch ?? []).map(value => pathToFileURL(resolve(cwdPath, value))),
    passthrough,
    launcherUrl,
    cwd: cwdUrl,
  }
}

function collect(value: string, previous: string[]): string[] {
  const next = [...previous]
  next.push(value)
  return next
}

export function buildCliArgs(
  args: LauncherArgs,
  effectiveProfile: string | undefined,
  enablePath: URL,
  enableOverlay: readonly unknown[],
): string[] {
  const [mode] = args.passthrough
  const patchArgs = [
    ...args.patchFiles.flatMap(file => ['--patch', fileURLToPath(file)]),
    ...(enableOverlay.length > 0 ? ['--patch', fileURLToPath(enablePath)] : []),
  ]
  let cliArgs: string[]
  if (mode === 'plugin') {
    if (patchArgs.length > 0) {
      console.error('stent-dsh: --patch overlays only apply when booting a profile, not for plugin')
      process.exit(1)
    }
    cliArgs = [...args.passthrough, ...(effectiveProfile ? ['--profile', effectiveProfile] : [])]
  } else if (mode === 'web') {
    if (args.profile !== undefined && args.profile !== 'web') {
      console.error(`stent-dsh: \`web\` boots the web profile; drop --profile ${args.profile} or omit the web alias`)
      process.exit(1)
    }
    // web's own --patch must precede the app args (passThroughOptions sends
    // everything after the first unknown token to the app).
    const [web = 'web', ...appArgs] = args.passthrough
    cliArgs = [web, ...patchArgs, ...appArgs]
  } else {
    // Generic boot takes the launcher flags first; the app args only start at
    // the first token the launcher does not know.
    cliArgs = [...(effectiveProfile ? ['--profile', effectiveProfile] : []), ...patchArgs, ...args.passthrough]
  }
  return cliArgs
}
