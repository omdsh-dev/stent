export interface LauncherArgs {
  source: string | undefined
  profile: string | undefined
  patchFiles: string[]
  passthrough: string[]
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): LauncherArgs {
  const args: LauncherArgs = {
    source: env.DSH_SOURCE,
    profile: undefined,
    patchFiles: [],
    passthrough: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === undefined) continue
    if (value === '--source') args.source = argv[++i]
    else if (value === '--profile') args.profile = argv[++i]
    else if (value === '--patch') args.patchFiles.push(argv[++i] as string)
    else if (value.startsWith('--patch=')) args.patchFiles.push(value.slice('--patch='.length))
    else args.passthrough.push(value)
  }
  // `web` is the CLI's hardcoded alias for --profile web: the layer
  // composition must follow the same profile the CLI will actually boot.
  if (args.profile === undefined && args.passthrough[0] === 'web') args.profile = 'web'
  return args
}

export function buildCliArgs(
  args: LauncherArgs,
  effectiveProfile: string | undefined,
  enablePath: string,
  enableOverlay: readonly unknown[],
): string[] {
  const [mode] = args.passthrough
  const patchArgs = [
    ...args.patchFiles.flatMap(file => ['--patch', file]),
    ...(enableOverlay.length > 0 ? ['--patch', enablePath] : []),
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
