import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LauncherArgs } from './args.ts'

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
type PatchRow = RecordValue & {
  id?: string
  disabled?: boolean
  config?: RecordValue
  insert?: unknown
}
type IdentifiedPatch = RecordValue & { id: string }

export interface ResolvedProfile {
  dshHome: URL
  profileName: string
  effectiveProfile: string | undefined
  profileDir: URL
}

export interface StentConfig {
  configPath: URL
  enablePath: URL
  enableOverlay: PatchRow[]
  patches: IdentifiedPatch[]
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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function childPath(base: URL, ...parts: string[]): URL {
  return pathToFileURL(join(fileURLToPath(base), ...parts))
}

function homeUrl(): URL {
  return pathToFileURL(join(homedir(), '.dsh'))
}

interface InstalledProfile {
  home: URL
  profile: string
}

function matchInstalledProfile(launcherUrl: URL): InstalledProfile | undefined {
  const launcher = fileURLToPath(launcherUrl)
  if (
    !matchesGlob(launcher, '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.js') &&
    !matchesGlob(launcher, '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.mjs')
  )
    return undefined

  const profileDir = dirname(dirname(dirname(dirname(dirname(launcher)))))
  const profilesDir = dirname(profileDir)
  const profile = basename(profileDir)
  return profile === '' ? undefined : { home: pathToFileURL(dirname(profilesDir)), profile }
}

/**
 * Resolve the profile like dsh does. An installed bundle bin additionally
 * derives both DSH_HOME and the profile name from its own path.
 */
export function resolveProfile({ profile, dshHome: configuredHome, launcherUrl }: LauncherArgs): ResolvedProfile {
  const installed = matchInstalledProfile(launcherUrl)
  const dshHome = installed === undefined ? (configuredHome ?? homeUrl()) : installed.home
  const profileName = installed === undefined ? (profile ?? 'default') : (profile ?? installed.profile)
  // An installed profile bin already identifies the profile. Reuse that name
  // when forwarding to the official CLI, even when the caller omits `web`.
  const effectiveProfile = profile ?? installed?.profile
  const profileDir = childPath(dshHome, 'profiles', profileName)
  if (!existsSync(profileDir)) {
    console.error(
      `stent-dsh: profile ${profileName} not found at ${fileURLToPath(profileDir)} (DSH_HOME=${fileURLToPath(dshHome)})`,
    )
    console.error(`  install the Stent npm bundle first: dsh plugin --profile ${profileName} add @oh-my-dsh/stent-pack`)
    process.exit(1)
  }
  return { dshHome, profileName, effectiveProfile, profileDir }
}

/** Resolve js-yaml from the profile first, then from the CLI package. */
export function resolveYaml(
  profileDir: URL,
  fromCli: NodeJS.Require,
): { requireFromProfile: NodeJS.Require; yaml: YamlApi } {
  const requireFromProfile = createRequire(childPath(profileDir, 'package.json'))
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
    console.error('stent-dsh: js-yaml is required (install it in the profile or beside the CLI)')
    process.exit(1)
  }
  return { requireFromProfile, yaml }
}

/** Load one YAML patch layer (empty array when the file is absent). */
function createPatchLoader(yaml: YamlApi): (path: URL) => PatchLayer {
  /** js-yaml schema tolerating the Loader's `!!js` expression tag. */
  let yamlSchema: unknown
  try {
    const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: data => data !== null,
      construct: data => data,
    })
    yamlSchema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  } catch {
    yamlSchema = undefined
  }

  return (path: URL): PatchLayer => {
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    const data = yamlSchema !== undefined ? yaml.load(text, { schema: yamlSchema }) : yaml.load(text)
    return Array.isArray(data) ? data : []
  }
}

/** Merge one patch layer into the row index with id-targeted semantics. */
function applyLayer(rows: Map<string, PatchRow>, layer: PatchLayer): void {
  for (const value of layer) {
    if (!isRecord(value)) continue
    if (Array.isArray(value.insert)) {
      for (const row of value.insert) {
        if (!isRecord(row) || typeof row.id !== 'string') continue
        rows.set(row.id, { ...(rows.get(row.id) ?? {}), ...row })
      }
    } else if (typeof value.id === 'string') {
      // id-targeted override replaces the whole row (disabled flag included).
      rows.set(value.id, { ...value })
    }
  }
}

/** Compose profile rows and create the temporary Stent handoff files. */
export function composeStentConfig({
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
  const bundlePatchFile = (manifestPath: string): URL | undefined => {
    try {
      const manifestPathname = requireFromProfile.resolve(`${manifestPath}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPathname, 'utf8')) as RecordValue
      const patchRel =
        isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle) && typeof manifest.dsh.bundle.patch === 'string'
          ? manifest.dsh.bundle.patch
          : undefined
      if (typeof patchRel !== 'string') return undefined
      return pathToFileURL(resolve(dirname(manifestPathname), patchRel))
    } catch {
      return undefined
    }
  }

  const profilePkgPath = childPath(profileDir, 'package.json')
  const profilePkg = (
    existsSync(profilePkgPath) ? JSON.parse(readFileSync(profilePkgPath, 'utf8')) : {}
  ) as ProfileManifest
  const bundlesValue = profilePkg.dsh?.profile?.bundles
  const bundles = Array.isArray(bundlesValue) ? bundlesValue : []

  const rows = new Map<string, PatchRow>()
  for (const bundle of bundles) {
    if (typeof bundle !== 'string') continue
    const patchPath = bundlePatchFile(bundle)
    if (patchPath !== undefined) applyLayer(rows, loadPatchLayer(patchPath))
  }
  applyLayer(rows, loadPatchLayer(childPath(profileDir, 'cordis.patch.yml')))
  applyLayer(rows, loadPatchLayer(childPath(dshHome, 'cordis.patch.yml')))
  for (const patchFile of args.patchFiles) applyLayer(rows, loadPatchLayer(patchFile))

  // A row whose config declares config.stent.patches (the stent
  // carrier row aside) hard-depends on Stent. Such rows ship disabled; the
  // launcher enables them through a generated overlay after every user layer.
  const enableOverlay: PatchRow[] = []
  const byId = new Map<string, IdentifiedPatch>()
  for (const [id, row] of rows) {
    const config = isRecord(row.config) ? row.config : undefined
    const stent = config !== undefined && isRecord(config.stent) ? config.stent : undefined
    const declared = stent?.patches
    if (!Array.isArray(declared)) continue
    for (const patch of declared) {
      if (isRecord(patch) && typeof patch.id === 'string') byId.set(patch.id, patch as IdentifiedPatch)
    }
    if (id !== 'stent' && row.disabled !== false) enableOverlay.push({ id, disabled: false })
  }
  // A Stent launcher invocation is the explicit opt-in for the DSH integration
  // row. Keep it disabled for plain `dsh`, but mount it for profile boots so
  // its post-boot required-patch check and hook summary can run. Plugin
  // management commands cannot receive generated profile overlays.
  const mode = args.passthrough[0]
  const isConfigDump = args.passthrough.includes('--dump-config') || args.passthrough.includes('--dump-default-config')
  if (mode !== 'plugin' && !isConfigDump) {
    const integration = rows.get('stent-dsh')
    if (
      integration !== undefined &&
      integration.disabled !== false &&
      !enableOverlay.some(row => row.id === 'stent-dsh')
    ) {
      enableOverlay.push({ id: 'stent-dsh', disabled: false })
    }
  }

  const patches = [...byId.values()]

  const temp = pathToFileURL(mkdtempSync(join(tmpdir(), 'stent-config-')))
  const configPath = childPath(temp, 'config.json')
  writeFileSync(configPath, JSON.stringify(patches))
  const enablePath = childPath(temp, 'enable.yaml')
  writeFileSync(enablePath, enableOverlay.length > 0 ? yaml.dump(enableOverlay) : '[]\n')
  return {
    configPath,
    enablePath,
    enableOverlay,
    patches,
    cleanup: () => {
      rmSync(temp, { recursive: true, force: true })
    },
  }
}

export type { YamlApi, PatchRow, IdentifiedPatch }
