/**
 * Stent-dsh preload: prepares the DSH launch before the official CLI entry
 * module evaluates. The bin only resolves the DSH path; this preload owns
 * profile composition, dependency healing, argv normalization, environment
 * setup, and Stent hook registration.
 *
 * The bin injects this file through NODE_OPTIONS so the official CLI and every
 * module it imports see the prepared process before their first evaluation.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { markStentDshLaunch } from '@oh-my-dsh/stent/activation'
import { installStentHooks } from '@oh-my-dsh/stent/loader'

import { buildCliArgs, parseOpt } from './stent-dsh/args.ts'
import { resolveHost } from './stent-dsh/cli.ts'
import { composeStentConfig, resolveProfile } from './stent-dsh/profile.ts'

/** First forwarded argv index: the Node binary and the CLI entry come first. */
const FORWARDED_ARGV_START = 2

/** The launcher options the argument parser hands to every launch step. */
type LauncherArgs = ReturnType<typeof parseOpt>
type ResolvedHost = ReturnType<typeof resolveHost>
type ProfilePaths = ReturnType<typeof resolveProfile>
type StentConfig = ReturnType<typeof composeStentConfig>

interface LaunchContext {
  readonly config: StentConfig
  readonly host: ResolvedHost
  readonly opt: LauncherArgs
  readonly profile: ProfilePaths
}

/** Heal the bundle's and the CLI's dependency closures before the CLI boots. */
function healProfiles(
  host: ResolvedHost,
  bundlePackageJson: URL,
  dshHome: URL,
): void {
  healProfilesModuleFallback(
    fileURLToPath(bundlePackageJson),
    fileURLToPath(dshHome),
  )
  healProfilesModuleFallback(
    fileURLToPath(host.cliPkgJson),
    fileURLToPath(dshHome),
  )
}

/** The launcher options this preload was started with. */
function launcherOptions(targetPath: string): LauncherArgs {
  const launcherUrl = new URL('stent-dsh.js', import.meta.url)
  const launcherCwd = pathToFileURL(
    `${process.env.STENT_LAUNCHER_CWD ?? process.cwd()}${path.sep}`,
  )
  return parseOpt(
    process.argv.slice(FORWARDED_ARGV_START),
    process.env,
    launcherUrl,
    launcherCwd,
    pathToFileURL(targetPath),
  )
}

/** Resolve the profile and compose its activation overlay. */
function composeLaunch(
  opt: LauncherArgs,
  host: ResolvedHost,
): {
  config: StentConfig
  profile: ProfilePaths
} {
  const profile = resolveProfile(opt)
  const config = composeStentConfig({
    args: opt,
    dshHome: profile.dshHome,
    profileDir: profile.profileDir,
    installAnchor: host.cliPkgJson,
  })
  return { config, profile }
}

/** Replace the launcher argv with the argument list the CLI expects. */
function applyCliArgv(
  opt: LauncherArgs,
  profile: ProfilePaths,
  config: StentConfig,
): void {
  const cliArgs = buildCliArgs(
    opt,
    profile.effectiveProfile,
    config.enablePath,
    config.enableOverlay,
  )
  const forwarded = process.argv.length - FORWARDED_ARGV_START
  process.argv.splice(FORWARDED_ARGV_START, forwarded, ...cliArgs)
}

/** Hand the resolved profile to the CLI and retire the launch handshake. */
function applyLaunchEnv(profile: ProfilePaths): void {
  process.env.STENT_PROFILE = fileURLToPath(profile.profileDir)
  process.env.DSH_HOME = fileURLToPath(profile.dshHome)
  process.env.STENT_PRELOAD_DONE = '1'
  delete process.env.STENT_DSH_LAUNCH
  delete process.env.STENT_DSH_PATH
  delete process.env.STENT_LAUNCHER_CWD
}

/** Claim the launch and install the hooks plugin patches register through. */
function installLaunchHooks(): void {
  markStentDshLaunch()
  installStentHooks()
  process.stderr.write(
    'stent: dynamic hooks installed — plugin patch registrations are live\n',
  )
}

/** Apply the composed launch to this process, in the order the CLI expects. */
function activateLaunch(context: LaunchContext): void {
  const { config, host, opt, profile } = context
  const bundlePackageJson = new URL('../package.json', opt.launcherUrl)
  healProfiles(host, bundlePackageJson, profile.dshHome)
  if (host.cwd !== undefined) {
    process.chdir(fileURLToPath(host.cwd))
  }
  applyCliArgv(opt, profile, config)
  applyLaunchEnv(profile)
  process.once('exit', config.cleanup)
  installLaunchHooks()
}

function prepareDshLaunch(): void {
  const targetPath = process.env.STENT_DSH_PATH
  if (targetPath === undefined || targetPath === '') {
    throw new Error(
      'stent-dsh: STENT_DSH_PATH is required for launcher preload',
    )
  }

  const opt = launcherOptions(targetPath)
  const host = resolveHost(opt)
  const { config, profile } = composeLaunch(opt, host)
  try {
    activateLaunch({ config, host, opt, profile })
  } catch (error) {
    config.cleanup()
    throw error
  }
}

if (
  process.env.STENT_PRELOAD_DONE !== '1'
  && process.env.STENT_DSH_LAUNCH === '1'
) {
  prepareDshLaunch()
}
