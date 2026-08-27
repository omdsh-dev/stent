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
export interface PackageIdentity {
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
 * Resolve the package identity of a module from its filesystem path or URL.
 *
 * @param urlOrPath - An absolute path or file URL.
 * @returns The owning package identity, or undefined outside any package.
 */
export function resolvePackageIdentity(
  urlOrPath: string,
): PackageIdentity | undefined {
  const filename = urlOrPath.startsWith('file:')
    ? fileURLToPath(urlOrPath)
    : urlOrPath
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
      manifest = {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        version: typeof parsed.version === 'string' ? parsed.version : '',
      }
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

/** Detect the module kind of a source file from its extension. */
export function detectModuleType(id: string): 'esm' | 'cjs' {
  const commonJs = id.endsWith('.cjs')
  if (commonJs) {
    return 'cjs'
  }
  return 'esm'
}
