/**
 * Module identity helpers used by the Stent matcher adapters.
 *
 * The nearest package.json identifies both installed and workspace modules.
 * This avoids relying on npm-layout path parsing and keeps the identity lookup
 * independent of package module format.
 *
 * @module @oh-my-dsh/stent/transform/identity
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One module's package identity: name, version, and package-relative path. */
interface PackageIdentity {
  /** Npm package name from the owning manifest. */
  name: string
  /** Version from the owning manifest. */
  version: string
  /** File path relative to the package root (forward slashes). */
  path: string
}

/** Nearest package root for a file, or undefined when none exists up the tree. */
function findPackageRoot(filename: string): string | undefined {
  let dir = dirname(filename)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

/** Manifest name/version cache, keyed by the package root directory. */
const manifestCache = new Map<string, { name: string; version: string }>()

/**
 * Resolve the package identity of a module from a path or file URL.
 *
 * The first ancestor containing `package.json` is the package root. Unreadable,
 * malformed, or unnamed manifests return `undefined`; a missing or non-string
 * version becomes an empty string, while any existing string is preserved even
 * if it is not valid semver. Manifest name/version results are cached for the
 * process.
 *
 * @param urlOrPath - A path (normally absolute) or a `file:` URL. Invalid file
 *   URLs can throw during conversion.
 * @returns The owning package identity, or undefined when no usable manifest is
 *   found.
 */
function resolvePackageIdentity(
  urlOrPath: string,
): PackageIdentity | undefined {
  let filename = urlOrPath
  if (urlOrPath.startsWith('file:')) {
    filename = fileURLToPath(urlOrPath)
  }
  const root = findPackageRoot(filename)
  if (root === undefined) {
    return undefined
  }
  let manifest = manifestCache.get(root)
  if (manifest === undefined) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      ) as {
        name?: unknown
        version?: unknown
      }
      let name = ''
      if (typeof parsed.name === 'string') {
        name = parsed.name
      }
      let version = ''
      if (typeof parsed.version === 'string') {
        version = parsed.version
      }
      manifest = { name, version }
    } catch {
      manifest = { name: '', version: '' }
    }
    manifestCache.set(root, manifest)
  }
  if (manifest.name === '') {
    return undefined
  }
  return {
    name: manifest.name,
    version: manifest.version,
    path: relative(root, filename).split(sep).join('/'),
  }
}

/**
 * Detect the module kind from a bundler or loader id.
 *
 * @param id - Module id to classify.
 * @returns `cjs` only when `id` literally ends in `.cjs`; every other id is
 *   `esm`.
 */
function detectModuleType(id: string): 'esm' | 'cjs' {
  if (id.endsWith('.cjs')) {
    return 'cjs'
  }
  return 'esm'
}

export { resolvePackageIdentity, detectModuleType }
export type { PackageIdentity }
