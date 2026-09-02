import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { LauncherArgs } from './args.ts'
import {
  bundlePatchFile,
  createEnableOverlay,
  profileBundles,
} from './profile-overlay.ts'

type RecordValue = Readonly<Record<string, unknown>>
type PatchLayer = readonly unknown[]
type YamlLoadOptions = Readonly<{ schema?: unknown }>
/** The overlay module owns the row shape every patch layer merges into. */
type PatchRow = ReturnType<typeof createEnableOverlay>[number]

interface YamlTypeOptions {
  readonly kind: 'scalar'
  readonly resolve: (data: unknown) => boolean
  readonly construct: (data: unknown) => unknown
}

interface YamlApi {
  readonly Type: new (tag: string, options: YamlTypeOptions) => unknown
  readonly DEFAULT_SCHEMA: {
    readonly extend: (types: readonly unknown[]) => unknown
  }
  readonly load: (text: string, options?: YamlLoadOptions) => unknown
  readonly dump: (value: unknown) => string
}

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

interface InstalledProfile {
  readonly home: URL
  readonly profile: string
}

interface ComposeOptions {
  readonly args: LauncherArgs
  readonly dshHome: URL
  readonly profileDir: URL
  readonly requireFromProfile: NodeJS.Require
  readonly yaml: YamlApi
}

/** Exit status used when the launch cannot be prepared. */
const EXIT_FAILURE = 1
/** Length of an overlay that contributes no rows. */
const EMPTY_OVERLAY = 0
/** Relative path from an installed bundle launcher to its profile directory. */
const LAUNCHER_TO_PROFILE = '../../../../..'

const installedLauncherGlobs = [
  '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.js',
  '**/profiles/*/node_modules/@oh-my-dsh/stent-pack/lib/stent-dsh.mjs',
]

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

/** Report why the launch cannot continue, then stop the process. */
function fail(lines: readonly string[]): never {
  for (const line of lines) {
    process.stderr.write(`${line}\n`)
  }
  process.exit(EXIT_FAILURE)
}

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

function matchInstalledProfile(launcherUrl: URL): InstalledProfile | undefined {
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

/**
 * Resolve the profile like dsh does; an installed bundle bin also derives
 * DSH_HOME and the profile name from its own path.
 */
function resolveProfile({
  profile,
  dshHome: configuredHome,
  launcherUrl,
}: LauncherArgs): ResolvedProfile {
  const installed = matchInstalledProfile(launcherUrl)
  const dshHome = installed?.home ?? configuredHome ?? homeUrl()
  const profileName = profile ?? installed?.profile ?? 'default'
  /* An installed profile bin already identifies the profile. Reuse that name
     when forwarding to the official CLI, even when the caller omits `web`. */
  const effectiveProfile = profile ?? installed?.profile
  const profileDir = childPath(dshHome, 'profiles', profileName)
  if (!existsSync(profileDir)) {
    fail([
      `stent-dsh: profile ${profileName} not found at ${fileURLToPath(profileDir)} (DSH_HOME=${fileURLToPath(dshHome)})`,
      `  install the Stent npm bundle first: dsh plugin --profile ${profileName} add @oh-my-dsh/stent-pack`,
    ])
  }
  return { dshHome, effectiveProfile, profileDir }
}

function isYamlApi(value: unknown): value is YamlApi {
  return (
    isRecord(value)
    && typeof value.Type === 'function'
    && typeof value.load === 'function'
    && typeof value.dump === 'function'
    && isRecord(value.DEFAULT_SCHEMA)
  )
}

/** Load js-yaml through one require entry, ignoring resolution failures. */
function loadYamlApi(from: NodeJS.Require): YamlApi | undefined {
  try {
    const loaded: unknown = from('js-yaml')
    if (isYamlApi(loaded)) {
      return loaded
    }
  } catch {
    /* Not resolvable from this entry. */
  }
  return undefined
}

/** Resolve js-yaml from the profile first, then from the CLI package. */
function resolveYaml(
  profileDir: URL,
  fromCli: NodeJS.Require,
): { requireFromProfile: NodeJS.Require; yaml: YamlApi } {
  const requireFromProfile = createRequire(
    childPath(profileDir, 'package.json'),
  )
  /* The CLI's own declared dependencies carry js-yaml (either host mode). */
  const yaml = loadYamlApi(requireFromProfile) ?? loadYamlApi(fromCli)
  if (yaml === undefined) {
    fail([
      'stent-dsh: js-yaml is required (install it in the profile or beside the CLI)',
    ])
  }
  return { requireFromProfile, yaml }
}

/** Js-yaml schema tolerating the Loader's `!!js` expression tag. */
function expressionSchema(yaml: YamlApi): unknown {
  try {
    const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data: unknown): boolean => data !== null,
      construct: (data: unknown): unknown => data,
    })
    return yaml.DEFAULT_SCHEMA.extend([jsTag])
  } catch {
    return undefined
  }
}

function loadDocument(yaml: YamlApi, text: string, schema: unknown): unknown {
  if (schema === undefined) {
    return yaml.load(text)
  }
  return yaml.load(text, { schema })
}

/** Load one YAML patch layer (empty array when the file is absent). */
function createPatchLoader(yaml: YamlApi): (file: URL) => PatchLayer {
  const schema = expressionSchema(yaml)
  return (file: URL): PatchLayer => {
    if (!existsSync(file)) {
      return []
    }
    const data = loadDocument(yaml, readFileSync(file, 'utf8'), schema)
    if (Array.isArray(data)) {
      return data
    }
    return []
  }
}

function applyInsert(rows: Map<string, PatchRow>, insert: PatchLayer): void {
  for (const row of insert) {
    if (isRecord(row) && typeof row.id === 'string') {
      rows.set(row.id, { ...rows.get(row.id), ...row })
    }
  }
}

function applyRow(rows: Map<string, PatchRow>, value: RecordValue): void {
  if (Array.isArray(value.insert)) {
    applyInsert(rows, value.insert)
  } else if (typeof value.id === 'string') {
    /* An id-targeted override replaces the whole row, disabled flag included. */
    rows.set(value.id, { ...value })
  }
}

/** Merge one patch layer into the row index with id-targeted semantics. */
function applyLayer(rows: Map<string, PatchRow>, layer: PatchLayer): void {
  for (const value of layer) {
    if (isRecord(value)) {
      applyRow(rows, value)
    }
  }
}

/** Patch files in layer order: bundles, profile, home, then CLI overrides. */
function patchSources({
  args,
  dshHome,
  profileDir,
  requireFromProfile,
}: ComposeOptions): URL[] {
  const manifest = fileURLToPath(childPath(profileDir, 'package.json'))
  const resolveBundle = requireFromProfile.resolve.bind(requireFromProfile)
  const bundlePatches = profileBundles(manifest)
    .map((bundle) => bundlePatchFile(resolveBundle, bundle))
    .filter((file) => file !== undefined)
    .map((file) => pathToFileURL(file))
  return [
    ...bundlePatches,
    childPath(profileDir, 'cordis.patch.yml'),
    childPath(dshHome, 'cordis.patch.yml'),
    ...args.patchFiles,
  ]
}

function composeRows(options: ComposeOptions): Map<string, PatchRow> {
  const loadPatchLayer = createPatchLoader(options.yaml)
  const rows = new Map<string, PatchRow>()
  for (const file of patchSources(options)) {
    applyLayer(rows, loadPatchLayer(file))
  }
  return rows
}

function dumpOverlay(yaml: YamlApi, overlay: readonly PatchRow[]): string {
  if (overlay.length > EMPTY_OVERLAY) {
    return yaml.dump(overlay)
  }
  return '[]\n'
}

/** Compose profile rows and create the temporary activation overlay. */
function composeStentConfig(options: ComposeOptions): StentConfig {
  const { args, yaml } = options
  const rows = composeRows(options)
  const enableOverlay = createEnableOverlay([...rows], args.passthrough)
  const overlayPrefix = path.join(tmpdir(), 'stent-overlay-')
  const temp = pathToFileURL(mkdtempSync(overlayPrefix))
  const enablePath = childPath(temp, 'enable.yaml')
  writeFileSync(enablePath, dumpOverlay(yaml, enableOverlay))
  return {
    enablePath,
    enableOverlay,
    cleanup: () => {
      rmSync(temp, { recursive: true, force: true })
    },
  }
}

export { resolveProfile, resolveYaml, composeStentConfig }
