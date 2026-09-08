/**
 * Import is the activation entry. The command wrapper supplies no handshake.
 * Every importing process installs hooks; only the actual DSH CLI prepares a
 * profile. Inherited NODE_OPTIONS therefore also works through pnpm and
 * workers.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { activateStent } from '@oh-my-dsh/stent/activation'
import { installStentHooks } from '@oh-my-dsh/stent/loader'

import { buildCliArgs, parseOpt } from './stent-dsh/args.ts'
import { resolveHost } from './stent-dsh/cli.ts'
import { composeStentConfig, resolveProfile } from './stent-dsh/profile.ts'

// oxlint-disable vitest/require-hook -- import entry must activate before host evaluation
const FORWARDED_ARGV_START = 2
type StentConfig = ReturnType<typeof composeStentConfig>

/** Own the temporary overlay for this process, including failed preparation. */
class ProfileBootstrap {
  private config: StentConfig | undefined

  public prepare(cliPackageJson: URL): void {
    const opt = parseOpt(
      process.argv.slice(FORWARDED_ARGV_START),
      process.env,
      new URL(import.meta.url),
      pathToFileURL(process.cwd() + path.sep),
    )
    const profile = resolveProfile(opt)
    const home = fileURLToPath(profile.dshHome)
    healProfilesModuleFallback(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      home,
    )
    healProfilesModuleFallback(fileURLToPath(cliPackageJson), home)
    this.config = composeStentConfig({
      args: opt,
      dshHome: profile.dshHome,
      profileDir: profile.profileDir,
      installAnchor: cliPackageJson,
    })
    try {
      const args = buildCliArgs(
        opt,
        profile.effectiveProfile,
        this.config.enablePath,
        this.config.enableOverlay,
      )
      process.argv.splice(FORWARDED_ARGV_START, Infinity, ...args)
      process.env.STENT_PROFILE = fileURLToPath(profile.profileDir)
      process.env.DSH_HOME = home
      process.once('exit', this.dispose.bind(this))
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  public dispose(): void {
    this.config?.cleanup()
    this.config = undefined
  }
}

installStentHooks()
activateStent()
const cliPackageJson = resolveHost()
if (cliPackageJson !== undefined) {
  new ProfileBootstrap().prepare(cliPackageJson)
}
