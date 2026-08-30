import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { LauncherArgs } from './args.ts'
import { createEnableOverlay, type PatchRow } from './profile-overlay.ts'

interface YamlTypeOptions {
  kind: 'scalar'
  resolve: (data: unknown) => boolean
  construct: (data: unknown) => unknown
}

interface YamlApi {
  Type: new (tag: string, options: YamlTypeOptions) => unknown
  DEFAULT_SCHEMA: { extend: (types: unknown[]) => unknown }
  load: (text: string, options?: { schema?: unknown }) => unknown
  dump: (value: unknown) => string
}

type RecordValue = Record<string, unknown>
type PatchLayer = unknown[]

interface ResolvedProfile {
  dshHome: URL
  effectiveProfile: string | undefined
  profileDir: URL
}

interface StentConfig {
  enablePath: URL
  enableOverlay: PatchRow[]
  cleanup: () => void
}

interface ProfileManifest {
  dsh?: {
    profile?: {
      bundles?: unknown
    }
  }
}

function isRecord(value: unknown): value is RecordValue {
  if (value === null) {
    return false
  }
  if (typeof value !== 'object') {
    return false
  }
  return !Array.isArray(value)
}

function childPath(base: URL, ...parts: string[]): URL {
  const basePath = fileURLToPath(base)
  const joinedPath = join(basePath, ...parts)
  return pathToFileURL(joinedPath)
}

function homeUrl(): URL {
  const homePath = homedir()
  const dshPath = join(homePath, '.dsh')
  return pathToFileURL(dshPath)
}

interface InstalledProfile {
  home: URL
  profile: string
}

function matchInstalledProfile(launcherUrl: URL): InstalledProfile | undefined {
  const launcher = fileURLToPath(launcherUrl)
  if (
    !matchesGlob(
      launcher,
      '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.js',
    )
    && !matchesGlob(
      launcher,
      '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.mjs',
    )
  ) {
    return undefined
  }

  const profileDir = dirname(dirname(dirname(dirname(dirname(launcher)))))
  const profilesDir = dirname(profileDir)
  const profile = basename(profileDir)
  if (profile === '') {
    return undefined
  }
  return { home: pathToFileURL(dirname(profilesDir)), profile }
}

/**
 * Resolve the profile like dsh does. An installed bundle bin additionally
 * derives both DSH_HOME and the profile name from its own path.
 */
function resolveProfile({
  profile,
  dshHome: configuredHome,
  launcherUrl,
}: LauncherArgs): ResolvedProfile {
  const installed = matchInstalledProfile(launcherUrl)
  let dshHome: URL
  if (installed === undefined) {
    dshHome = configuredHome ?? homeUrl()
  } else {
    dshHome = installed.home
  }
  let profileName: string
  if (installed === undefined) {
    profileName = profile ?? 'default'
  } else {
    profileName = profile ?? installed.profile
  }
  // An installed profile bin already identifies the profile. Reuse that name
  // when forwarding to the official CLI, even when the caller omits `web`.
  const effectiveProfile = profile ?? installed?.profile
  const profileDir = childPath(dshHome, 'profiles', profileName)
  if (!existsSync(profileDir)) {
    console.error(
      `stent-dsh: profile ${profileName} not found at ${fileURLToPath(profileDir)} (DSH_HOME=${fileURLToPath(dshHome)})`,
    )
    console.error(
      `  install the Stent npm bundle first: dsh plugin --profile ${profileName} add @oh-my-dsh/stent-pack`,
    )
    process.exit(1)
  }
  return { dshHome, effectiveProfile, profileDir }
}

/** Resolve js-yaml from the profile first, then from the CLI package. */
function resolveYaml(
  profileDir: URL,
  fromCli: NodeJS.Require,
): { requireFromProfile: NodeJS.Require; yaml: YamlApi } {
  const requireFromProfile = createRequire(
    childPath(profileDir, 'package.json'),
  )
  let yaml: YamlApi | undefined
  try {
    yaml = requireFromProfile('js-yaml') as YamlApi
  } catch {
    /* not in the profile */
  }
  if (yaml === undefined) {
    // The CLI's own declared dependencies carry js-yaml (either host mode).
    try {
      yaml = fromCli('js-yaml') as YamlApi
    } catch {
      /* not resolvable from the CLI */
    }
  }
  if (yaml === undefined) {
    console.error(
      'stent-dsh: js-yaml is required (install it in the profile or beside the CLI)',
    )
    process.exit(1)
  }
  return { requireFromProfile, yaml }
}

/** Load one YAML patch layer (empty array when the file is absent). */
function createPatchLoader(yaml: YamlApi): (path: URL) => PatchLayer {
  /** Js-yaml schema tolerating the Loader's `!!js` expression tag. */
  let yamlSchema: unknown
  try {
    const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => data !== null,
      construct: (data) => data,
    })
    yamlSchema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  } catch {
    yamlSchema = undefined
  }

  return (path: URL): PatchLayer => {
    if (!existsSync(path)) {
      return []
    }
    const text = readFileSync(path, 'utf8')
    let data: unknown
    if (yamlSchema !== undefined) {
      data = yaml.load(text, { schema: yamlSchema })
    } else {
      data = yaml.load(text)
    }
    if (Array.isArray(data)) {
      return data
    }
    return []
  }
}

/** Merge one patch layer into the row index with id-targeted semantics. */
function applyLayer(rows: Map<string, PatchRow>, layer: PatchLayer): void {
  for (const value of layer) {
    if (!isRecord(value)) {
      continue
    }
    if (Array.isArray(value.insert)) {
      for (const row of value.insert) {
        if (!isRecord(row) || typeof row.id !== 'string') {
          continue
        }
        rows.set(row.id, { ...(rows.get(row.id) ?? {}), ...row })
      }
    } else if (typeof value.id === 'string') {
      // id-targeted override replaces the whole row (disabled flag included).
      rows.set(value.id, { ...value })
    }
  }
}

function bundlePatchFile(
  requireFromProfile: NodeJS.Require,
  manifestPath: string,
): URL | undefined {
  try {
    const manifestPathname = requireFromProfile.resolve(
      `${manifestPath}/package.json`,
    )
    const manifest = JSON.parse(
      readFileSync(manifestPathname, 'utf8'),
    ) as RecordValue
    let patchRel: string | undefined
    if (
      isRecord(manifest.dsh)
      && isRecord(manifest.dsh.bundle)
      && typeof manifest.dsh.bundle.patch === 'string'
    ) {
      patchRel = manifest.dsh.bundle.patch
    }
    if (typeof patchRel !== 'string') {
      return undefined
    }
    return pathToFileURL(resolve(dirname(manifestPathname), patchRel))
  } catch {
    return undefined
  }
}

/** Compose profile rows and create the temporary activation overlay. */
function composeStentConfig({
  args,
  dshHome,
  profileDir,
  requireFromProfile,
  yaml,
}: {
  args: LauncherArgs
  dshHome: URL
  profileDir: URL
  requireFromProfile: NodeJS.Require
  yaml: YamlApi
}): StentConfig {
  const loadPatchLayer = createPatchLoader(yaml)

  const profilePkgPath = childPath(profileDir, 'package.json')
  let profilePkg: ProfileManifest
  if (existsSync(profilePkgPath)) {
    profilePkg = JSON.parse(
      readFileSync(profilePkgPath, 'utf8'),
    ) as ProfileManifest
  } else {
    profilePkg = {}
  }
  const bundlesValue = profilePkg.dsh?.profile?.bundles
  let bundles: unknown[]
  if (Array.isArray(bundlesValue)) {
    bundles = bundlesValue
  } else {
    bundles = []
  }

  const rows = new Map<string, PatchRow>()
  for (const bundle of bundles) {
    if (typeof bundle !== 'string') {
      continue
    }
    const patchPath = bundlePatchFile(requireFromProfile, bundle)
    if (patchPath !== undefined) {
      applyLayer(rows, loadPatchLayer(patchPath))
    }
  }
  applyLayer(rows, loadPatchLayer(childPath(profileDir, 'cordis.patch.yml')))
  applyLayer(rows, loadPatchLayer(childPath(dshHome, 'cordis.patch.yml')))
  for (const patchFile of args.patchFiles) {
    applyLayer(rows, loadPatchLayer(patchFile))
  }

  const enableOverlay = createEnableOverlay(rows, args.passthrough)

  const temp = pathToFileURL(mkdtempSync(join(tmpdir(), 'stent-overlay-')))
  const enablePath = childPath(temp, 'enable.yaml')
  let enableContents: string
  if (enableOverlay.length > 0) {
    enableContents = yaml.dump(enableOverlay)
  } else {
    enableContents = '[]\n'
  }
  writeFileSync(enablePath, enableContents)
  return {
    enablePath,
    enableOverlay,
    cleanup: () => {
      rmSync(temp, { recursive: true, force: true })
    },
  }
}

export { resolveProfile, resolveYaml, composeStentConfig }
