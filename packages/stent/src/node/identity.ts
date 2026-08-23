/**
 * Module-identity helpers shared by the Node loader and the browser build
 * transform: package-version lookup, workspace-package identity, and
 * module-type detection.
 * @module @oh-my-dsh/stent/node/identity
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import parse from 'module-details-from-path'

/**
 * Read the version field of the owning package.json.
 * @param basedir - package directory as a file URL or filesystem path.
 * @returns the version string, or `''` when it cannot be determined.
 */
export function getPackageVersion(basedir: string): string {
  try {
    const url = new URL(basedir)
    if (url.protocol === 'file:') basedir = fileURLToPath(url)
  } catch {
    // Already a filesystem path.
  }
  try {
    const manifest = JSON.parse(readFileSync(join(basedir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/** One module's package identity: name, version, and package-relative path. */
export interface PackageIdentity {
  /** npm package name from the owning manifest. */
  name: string
  /** Version from the owning manifest. */
  version: string
  /** File path relative to the package root (forward slashes). */
  path: string
}

/** Manifest name/version cache, keyed by the package root directory. */
const manifestCache = new Map<string, { name: string; version: string }>()

/** Nearest package root for a file, or undefined when none exists up the tree. */
function findPackageRoot(filename: string): string | undefined {
  let dir = dirname(filename)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve the package identity of a module from its filesystem path alone:
 * walk up to the nearest package.json and read its name and version. This is
 * the workspace-package counterpart of module-details-from-path — Node
 * resolves workspace links to their real paths, so the npm-layout parser
 * cannot name them, while the nearest manifest always can.
 * @param filename - the module's filesystem path (never a URL).
 * @returns the owning package identity, or undefined outside any package.
 */
export function packageIdentityFromPath(filename: string): PackageIdentity | undefined {
  const root = findPackageRoot(filename)
  if (root === undefined) return undefined
  let manifest = manifestCache.get(root)
  if (manifest === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      manifest = {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        version: typeof parsed.version === 'string' ? parsed.version : '',
      }
    } catch {
      manifest = { name: '', version: '' }
    }
    manifestCache.set(root, manifest)
  }
  if (manifest.name === '') return undefined
  return {
    name: manifest.name,
    version: manifest.version,
    path: relative(root, filename).split(sep).join('/'),
  }
}

/**
 * Resolve a Node-loaded module id through the npm-layout parser first and the
 * nearest package manifest fallback for workspace links.
 */
export function nodePackageIdentity(urlOrPath: string): PackageIdentity | undefined {
  const filename = urlOrPath.startsWith('file:') ? fileURLToPath(urlOrPath) : urlOrPath
  const details = parse(filename)
  if (details !== undefined) {
    return { name: details.name, version: getPackageVersion(details.basedir), path: details.path }
  }
  return packageIdentityFromPath(filename)
}

/** Detect the module kind of a source file from its extension. */
export function detectModuleType(id: string): 'esm' | 'cjs' {
  return id.endsWith('.cjs') ? 'cjs' : 'esm'
}
