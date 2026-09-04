import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PROFILE_PATCH_FILENAME,
  composeEntries,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'

import type { LauncherArgs } from './args.ts'
import { createEnableOverlay } from './profile-overlay.ts'

type PatchRow = ReturnType<typeof createEnableOverlay>[number]
type ComposedRow = ReturnType<typeof composeEntries>[number]

interface ResolvedProfile {
  readonly dshHome: URL
  readonly effectiveProfile: string | undefined
  readonly profileDir: URL
}

interface StentConfig {
  readonly enablePath: URL
  readonly enableOverlay: PatchRow[]
  readonly cleanup: () => void
}

interface ComposeOptions {
  readonly args: LauncherArgs
  readonly dshHome: URL
  readonly profileDir: URL
  readonly installAnchor: URL
}

/** Relative path from an installed bundle launcher to its profile directory. */
const LAUNCHER_TO_PROFILE = '../../../../..'
const NO_ENTRIES = 0
const JSON_INDENT = 2

const installedLauncherGlobs = [
  '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.js',
  '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.mjs',
]

function childPath(base: URL, ...parts: string[]): URL {
  const basePath = fileURLToPath(base)
  const joinedPath = path.join(basePath, ...parts)
  return pathToFileURL(joinedPath)
}

function homeUrl(): URL {
  const homePath = homedir()
  const dshPath = path.join(homePath, '.dsh')
  return pathToFileURL(dshPath)
}

function matchInstalledProfile(
  launcherUrl: URL,
): { home: URL; profile: string } | undefined {
  const launcher = fileURLToPath(launcherUrl)
  const isInstalled = installedLauncherGlobs.some((pattern) =>
    path.matchesGlob(launcher, pattern),
  )
  if (!isInstalled) {
    return undefined
  }
  const profileDir = path.resolve(launcher, LAUNCHER_TO_PROFILE)
  const profile = path.basename(profileDir)
  if (profile === '') {
    return undefined
  }
  const profilesDir = path.dirname(profileDir)
  return { home: pathToFileURL(path.dirname(profilesDir)), profile }
}

/** Resolve the profile path with the official DSH profile-name rules. */
function resolveProfile({
  profile,
  dshHome: configuredHome,
  launcherUrl,
}: LauncherArgs): ResolvedProfile {
  const installed = matchInstalledProfile(launcherUrl)
  const dshHome = installed?.home ?? configuredHome ?? homeUrl()
  const profileName = profile ?? installed?.profile ?? 'default'
  const effectiveProfile = profile ?? installed?.profile
  const profileDir = pathToFileURL(
    resolveProfileDir(profileName, fileURLToPath(dshHome)),
  )
  return { dshHome, effectiveProfile, profileDir }
}

/** Load every profile layer through DSH app-boot, then apply launcher overlays. */
function composeRows(
  options: ComposeOptions,
): readonly (readonly [string, ComposedRow])[] {
  const profileName = path.basename(fileURLToPath(options.profileDir))
  const profile = loadProfile(
    'stent-dsh',
    profileName,
    fileURLToPath(options.installAnchor),
    fileURLToPath(options.dshHome),
  )
  const homePatchPath = path.join(
    fileURLToPath(options.dshHome),
    PROFILE_PATCH_FILENAME,
  )
  const homePatches = loadOptionalPatches('stent-dsh', homePatchPath) ?? []
  const overlayPatches = options.args.patchFiles.flatMap((file) =>
    loadOverlayPatches('stent-dsh', fileURLToPath(file)),
  )
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
  return composeEntries([
    bundlePatches,
    profile.patches,
    homePatches,
    overlayPatches,
  ]).map((row) => [row.id, row] as const)
}

function dumpOverlay(overlay: readonly PatchRow[]): string {
  if (overlay.length === NO_ENTRIES) {
    return '[]\n'
  }
  return `${JSON.stringify(overlay, undefined, JSON_INDENT)}\n`
}

/** Compose the Stent activation overlay and return its temporary file. */
function composeStentConfig(options: ComposeOptions): StentConfig {
  const enableOverlay = createEnableOverlay(
    composeRows(options),
    options.args.passthrough,
  )
  const tempPath = mkdtempSync(path.join(tmpdir(), 'stent-overlay-'))
  const enablePath = childPath(pathToFileURL(tempPath), 'enable.yaml')
  writeFileSync(enablePath, dumpOverlay(enableOverlay))
  return {
    enablePath,
    enableOverlay,
    cleanup: () => {
      rmSync(tempPath, { recursive: true, force: true })
    },
  }
}

export { resolveProfile, composeStentConfig }
