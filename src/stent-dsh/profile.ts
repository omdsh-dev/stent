import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  dshHome: string
  profileName: string
  effectiveProfile: string | undefined
  profileDir: string
  installedMatch: RegExpMatchArray | null
}

export interface StentConfig {
  configPath: string
  enablePath: string
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

/**
 * Resolve the profile like dsh does. An installed bundle bin additionally
 * derives both DSH_HOME and the profile name from its own path.
 */
export function resolveProfile({
  args,
  launcherUrl,
  env = process.env,
}: {
  args: LauncherArgs
  launcherUrl: string | URL
  env?: NodeJS.ProcessEnv
}): ResolvedProfile {
  const installedMatch = fileURLToPath(launcherUrl)
    .match(/^(.*)\/profiles\/([^/]+)\/node_modules\/@oh-my-dsh\/stent-pack\/lib\/stent-dsh\.(?:js|mjs)$/)
  const installedHome = installedMatch?.[1]
  const installedProfile = installedMatch?.[2]
  const installed = installedHome !== undefined && installedProfile !== undefined
  const dshHome = installed
    ? installedHome
    : env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileName = installed
    ? (args.profile ?? installedProfile)
    : args.profile ?? env.DSH_PROFILE ?? 'default'
  // An installed profile bin already identifies the profile. Reuse that name
  // when forwarding to the official CLI, even when the caller omits `web`.
  const effectiveProfile = args.profile ?? (installed ? installedProfile : undefined)
  const profileDir = join(dshHome, 'profiles', profileName)
  if (!existsSync(profileDir)) {
    console.error(`stent-dsh: profile ${profileName} not found at ${profileDir} (DSH_HOME=${dshHome})`)
    console.error(`  install the Stent npm bundle first: dsh plugin --profile ${profileName} add @oh-my-dsh/stent-pack`)
    process.exit(1)
  }
  return { dshHome, profileName, effectiveProfile, profileDir, installedMatch }
}

/** Resolve js-yaml from the profile first, then from the CLI package. */
export function resolveYaml(profileDir: string, fromCli: NodeJS.Require): { requireFromProfile: NodeJS.Require; yaml: YamlApi } {
  const requireFromProfile = createRequire(join(profileDir, 'package.json'))
  let yaml: YamlApi | undefined
  try { yaml = requireFromProfile('js-yaml') as YamlApi } catch { /* not in the profile */ }
  if (yaml === undefined) {
    // The CLI's own declared dependencies carry js-yaml (either host mode).
    try { yaml = fromCli('js-yaml') as YamlApi } catch { /* not resolvable from the CLI */ }
  }
  if (yaml === undefined) {
    console.error('stent-dsh: js-yaml is required (install it in the profile or beside the CLI)')
    process.exit(1)
  }
  return { requireFromProfile, yaml }
}

/** Load one YAML patch layer (empty array when the file is absent). */
function createPatchLoader(yaml: YamlApi): (path: string) => PatchLayer {
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

  return (path: string): PatchLayer => {
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    const data = yamlSchema !== undefined
      ? yaml.load(text, { schema: yamlSchema })
      : yaml.load(text)
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
  dshHome: string
  profileDir: string
  requireFromProfile: NodeJS.Require
  yaml: YamlApi
}): StentConfig {
  const loadPatchLayer = createPatchLoader(yaml)
  const bundlePatchFile = (manifestPath: string): string | undefined => {
    try {
      const manifestPathname = requireFromProfile.resolve(`${manifestPath}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPathname, 'utf8')) as RecordValue
      const patchRel = isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle) && typeof manifest.dsh.bundle.patch === 'string'
        ? manifest.dsh.bundle.patch
        : undefined
      if (typeof patchRel !== 'string') return undefined
      return resolve(join(manifestPathname, '..', patchRel))
    } catch {
      return undefined
    }
  }

  const profilePkgPath = join(profileDir, 'package.json')
  const profilePkg = (existsSync(profilePkgPath)
    ? JSON.parse(readFileSync(profilePkgPath, 'utf8'))
    : {}) as ProfileManifest
  const bundlesValue = profilePkg.dsh?.profile?.bundles
  const bundles = Array.isArray(bundlesValue) ? bundlesValue : []

  const rows = new Map<string, PatchRow>()
  for (const bundle of bundles) {
    if (typeof bundle !== 'string') continue
    const patchPath = bundlePatchFile(bundle)
    if (patchPath !== undefined) applyLayer(rows, loadPatchLayer(patchPath))
  }
  applyLayer(rows, loadPatchLayer(join(profileDir, 'cordis.patch.yml')))
  applyLayer(rows, loadPatchLayer(join(dshHome, 'cordis.patch.yml')))
  for (const patchFile of args.patchFiles) applyLayer(rows, loadPatchLayer(resolve(patchFile)))

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
  const patches = [...byId.values()]

  const temp = mkdtempSync(join(tmpdir(), 'stent-config-'))
  const configPath = join(temp, 'config.json')
  writeFileSync(configPath, JSON.stringify(patches))
  const enablePath = join(temp, 'enable.yaml')
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
