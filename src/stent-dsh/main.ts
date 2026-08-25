/**
 * stent-dsh: the plug-and-play Stent launcher. Runs the official dsh CLI
 * with the Stent transformation hooks injected through a preload — the host
 * source stays untouched; the hooks only exist when this command is used.
 *
 * Usage:
 *   node lib/stent-dsh.js [dsh args...]                  (installed bundle)
 *   node --import tsx/esm src/stent-dsh.ts --dsh-path <checkout> [...]
 *
 * The CLI resolves an explicit DSH path as a source checkout, an installed
 * package, or a bin file. With no path it searches the caller's dependency
 * and `dsh` on PATH. A source TypeScript entry runs through tsx; an installed
 * JavaScript entry runs directly. *
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
 * the official CLI with the preload reading that file. A `stent-dsh` profile
 * launch also enables its own integration row through a generated overlay;
 * this makes the post-boot required-patch check and hook summary run. Rows
 * that declare stent patches are Stent-required: they ship disabled, and this
 * command enables them through the same generated overlay (after every user
 * layer), so a plain `dsh` boot skips such rows entirely while this launch
 * loads them with the hooks already installed.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildCliArgs } from './args.ts'
import type { LauncherArgs } from './args.ts'
import { resolveHost, type ResolvedHost } from './cli.ts'
import { composeStentConfig, resolveProfile, resolveYaml, type StentConfig } from './profile.ts'

/**
 * Run the Stent launcher. The entry module passes its own URL so installed
 * bundle invocations can derive DSH_HOME/profile from the bin's real path.
 */
export async function main(opt: LauncherArgs): Promise<never> {
  // A bare spawnSync parent never returns once its child dies of SIGINT: the
  // sync wait loop swallows the signal and the shell hangs until a second ^C.
  // The child still receives every signal directly and owns its own graceful
  // first-^C / forceful second-^C escalation.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})

  const host: ResolvedHost = resolveHost(opt)
  const profile = resolveProfile(opt)
  const { requireFromProfile, yaml } = resolveYaml(profile.profileDir, host.fromCli)
  const config: StentConfig = composeStentConfig({
    args: opt,
    dshHome: profile.dshHome,
    profileDir: profile.profileDir,
    requireFromProfile,
    yaml,
  })
  const cliArgs = buildCliArgs(opt, profile.effectiveProfile, config.enablePath, config.enableOverlay)

  // Heal both dependency closures before the preload imports the profile's
  // trio: the DSH installation provides host packages, while the root
  // bundle's declared npm dependencies provide the Stent packages. The healer
  // creates the profile-level names from the installed package locations.
  const bundlePackageJson = new URL('../package.json', opt.launcherUrl)
  await healProfiles(host, bundlePackageJson, profile.dshHome)

  const childArgs = [
    ...host.nodeArgs,
    '--import',
    fileURLToPath(bundledPreloadPath(opt.launcherUrl)),
    fileURLToPath(host.dshPath),
    ...cliArgs,
  ]
  process.stderr.write(
    `stent-dsh: exec ${[process.execPath, ...childArgs].map(value => JSON.stringify(value)).join(' ')}\n`,
  )

  const result = spawnSync(
    process.execPath,
    childArgs,
    // Source mode runs from the source checkout: tsx resolves its tsconfig
    // there. Installed mode needs no pinned cwd: the published bin is plain ESM.
    {
      stdio: 'inherit',
      ...(host.cwd === undefined ? {} : { cwd: fileURLToPath(host.cwd) }),
      env: {
        ...opt.env,
        STENT_CONFIG: fileURLToPath(config.configPath),
        STENT_PROFILE: fileURLToPath(profile.profileDir),
        DSH_HOME: fileURLToPath(profile.dshHome),
      },
    },
  )
  config.cleanup()
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 0)
}

async function healProfiles(host: ResolvedHost, bundlePackageJson: URL, dshHome: URL): Promise<void> {
  const modulePath = host.fromCli.resolve('@deepseek-ai/dsh-app-boot')
  const { healProfilesModuleFallback } = (await import(pathToFileURL(modulePath).href)) as {
    healProfilesModuleFallback: (packageJson: string, dshHome: string) => void
  }
  healProfilesModuleFallback(fileURLToPath(bundlePackageJson), fileURLToPath(dshHome))
  healProfilesModuleFallback(fileURLToPath(host.cliPkgJson), fileURLToPath(dshHome))
}

function bundledPreloadPath(launcherUrl: URL): URL {
  return new URL('../lib/stent-dsh-preload.js', launcherUrl)
}
