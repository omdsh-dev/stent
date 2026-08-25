/**
 * stent-dsh preload: prepares the DSH launch before the official CLI entry
 * module evaluates. The bin only resolves the DSH path; this preload owns
 * profile composition, dependency healing, argv normalization, environment
 * setup, and Stent hook registration.
 *
 * The bin injects this file through NODE_OPTIONS so the official CLI and every
 * module it imports see the prepared process before their first evaluation.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { sep } from 'node:path'
import { expandPatchStub, installStentHooks } from '@oh-my-dsh/stent/node/loader'
import { markStentDshLaunch } from '@oh-my-dsh/stent/activation'
import type { StentPatchStub } from '@oh-my-dsh/stent/types'
import { buildCliArgs, parseOpt } from './stent-dsh/args.ts'
import { resolveHost } from './stent-dsh/cli.ts'
import { composeStentConfig, resolveProfile, resolveYaml } from './stent-dsh/profile.ts'

if (process.env.STENT_PRELOAD_DONE !== '1') {
  if (process.env.STENT_DSH_LAUNCH === '1') await prepareDshLaunch()
  else installConfiguredHooks()
}

async function prepareDshLaunch(): Promise<void> {
  const targetPath = process.env.STENT_DSH_PATH
  if (targetPath === undefined || targetPath === '') {
    throw new Error('stent-dsh: STENT_DSH_PATH is required for launcher preload')
  }

  const launcherUrl = new URL('./stent-dsh.js', import.meta.url)
  const launcherCwd = pathToFileURL(`${process.env.STENT_LAUNCHER_CWD ?? process.cwd()}${sep}`)
  const dshPath = pathToFileURL(targetPath)
  const opt = parseOpt(process.argv.slice(2), process.env, launcherUrl, launcherCwd, dshPath)
  const host = resolveHost(opt)
  const profile = resolveProfile(opt)
  const { requireFromProfile, yaml } = resolveYaml(profile.profileDir, host.fromCli)
  const config = composeStentConfig({
    args: opt,
    dshHome: profile.dshHome,
    profileDir: profile.profileDir,
    requireFromProfile,
    yaml,
  })

  try {
    const bundlePackageJson = new URL('../package.json', launcherUrl)
    await healProfiles(host, bundlePackageJson, profile.dshHome)
    if (host.cwd !== undefined) process.chdir(fileURLToPath(host.cwd))

    const cliArgs = buildCliArgs(opt, profile.effectiveProfile, config.enablePath, config.enableOverlay)
    process.argv.splice(2, process.argv.length - 2, ...cliArgs)
    process.env.STENT_CONFIG = fileURLToPath(config.configPath)
    process.env.STENT_PROFILE = fileURLToPath(profile.profileDir)
    process.env.DSH_HOME = fileURLToPath(profile.dshHome)
    process.env.STENT_PRELOAD_DONE = '1'
    delete process.env.STENT_DSH_LAUNCH
    delete process.env.STENT_DSH_PATH
    delete process.env.STENT_LAUNCHER_CWD
    process.once('exit', config.cleanup)

    markStentDshLaunch()
    installStentHooks(config.patches.flatMap(patch => expandPatchStub(patch as StentPatchStub)))
    process.stderr.write(
      `stent: Stent hooks installed (${config.patches.length} descriptor(s)) — this launch is stent-enabled\n`,
    )
  } catch (error) {
    config.cleanup()
    throw error
  }
}

function installConfiguredHooks(): void {
  const configPath = process.env.STENT_CONFIG
  if (configPath === undefined || configPath === '') return
  markStentDshLaunch()
  const descriptors = JSON.parse(readFileSync(pathToFileURL(configPath), 'utf8')) as StentPatchStub[]
  installStentHooks(descriptors.flatMap(expandPatchStub))
  process.env.STENT_PRELOAD_DONE = '1'
  process.stderr.write(
    `stent: Stent hooks installed (${descriptors.length} descriptor(s)) — this launch is stent-enabled\n`,
  )
}

async function healProfiles(host: ReturnType<typeof resolveHost>, bundlePackageJson: URL, dshHome: URL): Promise<void> {
  const modulePath = host.fromCli.resolve('@deepseek-ai/dsh-app-boot')
  const { healProfilesModuleFallback } = (await import(pathToFileURL(modulePath).href)) as {
    healProfilesModuleFallback: (packageJson: string, dshHome: string) => void
  }
  healProfilesModuleFallback(fileURLToPath(bundlePackageJson), fileURLToPath(dshHome))
  healProfilesModuleFallback(fileURLToPath(host.cliPkgJson), fileURLToPath(dshHome))
}
