/**
 * stent-dsh: the plug-and-play Stent launcher. Runs the official dsh CLI
 * with the Stent transformation hooks injected through a preload — the host
 * source stays untouched; the hooks only exist when this command is used.
 *
 * Usage:
 *   node lib/stent-dsh.js [dsh args...]                  (installed bundle)
 *   node --import tsx/esm src/stent-dsh.ts --source <checkout> [...]
 *
 * Installed mode (default) runs a registry-installed @deepseek-ai/dsh: the
 * published lib/bin.js and bundled preload are plain ESM, so no tsx or
 * checkout is needed.
 * The CLI resolves from DSH_CLI, the caller's project dependencies, or a
 * `dsh` on PATH. Source mode (DSH_SOURCE) runs the checkout's
 * apps/cli/src/bin.ts through tsx instead. Profile resolution follows dsh:
 * DSH_HOME/profiles/<name>.
 *
 * Installed bundle form — no bundle checkout required: the bundle ships this
 * launcher (bin `stent-dsh`) after installation through the release plugin
 * channel:
 *
 *   $DSH_HOME/profiles/web/node_modules/.bin/stent-dsh --port 8000
 *
 * (home and profile name then derive from the install path itself.)
 *
 * Composition: the command resolves the profile's patch layers (bundle
 * cordis.patch.yml files in `dsh.profile.bundles` order, the profile's own
 * cordis.patch.yml, $DSH_HOME/cordis.patch.yml, then --patch overlays),
 * merges them with the Loader's id-targeted semantics, aggregates the
 * `config.stent.patches` descriptors every row declares (the stent
 * row is the canonical carrier), writes them to a temp JSON, and launches
 * the official CLI with the preload reading that file. A row that declares
 * stent patches is Stent-required: it ships disabled, and this command
 * enables it through a generated --patch overlay (after every user layer),
 * so a plain `dsh` boot skips such rows entirely while this launch loads
 * them with the hooks already installed.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildCliArgs, parseArgs } from './args.ts'
import { resolveHost, type ResolvedHost } from './cli.ts'
import { composeStentConfig, resolveProfile, resolveYaml, type StentConfig } from './profile.ts'
import type { LauncherArgs } from './args.ts'

export interface LauncherOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  launcherUrl?: string | URL
}

/**
 * Run the Stent launcher. The entry module passes its own URL so installed
 * bundle invocations can derive DSH_HOME/profile from the bin's real path.
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  launcherUrl = import.meta.url,
}: LauncherOptions = {}): never {
  const args: LauncherArgs = parseArgs(argv, env)

  // A bare spawnSync parent never returns once its child dies of SIGINT: the
  // sync wait loop swallows the signal and the shell hangs until a second ^C.
  // The child still receives every signal directly and owns its own graceful
  // first-^C / forceful second-^C escalation.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})

  const host: ResolvedHost = resolveHost(args, { cwd: process.cwd(), env })
  const profile = resolveProfile({ args, launcherUrl, env })
  const { requireFromProfile, yaml } = resolveYaml(profile.profileDir, host.fromCli)
  const config: StentConfig = composeStentConfig({
    args,
    dshHome: profile.dshHome,
    profileDir: profile.profileDir,
    requireFromProfile,
    yaml,
  })
  const cliArgs = buildCliArgs(args, profile.effectiveProfile, config.enablePath, config.enableOverlay)

  // Heal both dependency closures before the preload imports the profile's
  // trio: the DSH installation provides host packages, while the root
  // bundle's declared npm dependencies provide the Stent packages. The healer
  // creates the profile-level names from the installed package locations.
  const bundlePackageJson = fileURLToPath(new URL('../package.json', launcherUrl))
  const healEval = host.source
    ? `const { healProfilesModuleFallback } = await import('@deepseek-ai/dsh-app-boot'); healProfilesModuleFallback(${JSON.stringify(bundlePackageJson)}); healProfilesModuleFallback(${JSON.stringify(host.cliPkgJson)})`
    : `const { createRequire } = await import('node:module'); const { healProfilesModuleFallback } = await import(createRequire(${JSON.stringify(pathToFileURL(host.realBin).href)}).resolve('@deepseek-ai/dsh-app-boot')); healProfilesModuleFallback(${JSON.stringify(bundlePackageJson)}); healProfilesModuleFallback(${JSON.stringify(host.cliPkgJson)})`
  const heal = spawnSync(
    process.execPath,
    [...(host.source ? ['--import', 'tsx/esm'] : []), '--input-type=module', '--eval', healEval],
    { stdio: 'inherit', ...(host.source ? { cwd: host.sourceRoot } : {}), env: { ...env, DSH_HOME: profile.dshHome } },
  )
  if (heal.error !== undefined) throw heal.error
  if (heal.status !== 0) process.exit(heal.status ?? 1)

  const result = spawnSync(
    process.execPath,
    [
      ...(host.source ? ['--import', 'tsx/esm'] : []),
      '--import',
      bundledPreloadPath(launcherUrl),
      host.bin,
      ...cliArgs,
    ],
    // Source mode runs from the source checkout: tsx resolves its tsconfig
    // there. Installed mode needs no pinned cwd: the published bin is plain ESM.
    {
      stdio: 'inherit',
      ...(host.source ? { cwd: host.sourceRoot } : {}),
      env: { ...env, STENT_CONFIG: config.configPath, STENT_PROFILE: profile.profileDir, DSH_HOME: profile.dshHome },
    },
  )
  config.cleanup()
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 0)
}

function bundledPreloadPath(launcherUrl: string | URL): string {
  return fileURLToPath(new URL('../lib/stent-dsh-preload.js', launcherUrl))
}
