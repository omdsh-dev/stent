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
import path from 'node:path'
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

/** Manifest name/version fields read from a package root. */
interface ManifestFields {
  /** Npm package name from the owning manifest. */
  name: string
  /** Version from the owning manifest. */
  version: string
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

/** A JSON value as a string, or empty for any non-string value. */
function stringField(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return ''
}

/** Nearest package root for a file, or undefined when none exists up the tree. */
function findPackageRoot(filename: string): string | undefined {
  let dir = path.dirname(filename)
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

/** Manifest name/version cache, keyed by the package root directory. */
const manifestCache = new Map<string, ManifestFields>()

/**
 * Read the manifest fields of a package root; unreadable or malformed files
 * yield empty fields.
 */
function readManifest(root: string): ManifestFields {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    )
    if (isRecord(parsed)) {
      const { name, version } = parsed
      return { name: stringField(name), version: stringField(version) }
    }
    return { name: '', version: '' }
  } catch {
    return { name: '', version: '' }
  }
}

/** Cached manifest fields for a package root. */
function manifestFor(root: string): ManifestFields {
  const cached = manifestCache.get(root)
  if (cached !== undefined) {
    return cached
  }
  const manifest = readManifest(root)
  manifestCache.set(root, manifest)
  return manifest
}

/** Convert a file URL to a path, passing plain paths through unchanged. */
function toFilePath(urlOrPath: string): string {
  if (urlOrPath.startsWith('file:')) {
    return fileURLToPath(urlOrPath)
  }
  return urlOrPath
}

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
  const filename = toFilePath(urlOrPath)
  const root = findPackageRoot(filename)
  if (root === undefined) {
    return undefined
  }
  const manifest = manifestFor(root)
  if (manifest.name === '') {
    return undefined
  }
  return {
    name: manifest.name,
    version: manifest.version,
    path: path.relative(root, filename).split(path.sep).join('/'),
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
