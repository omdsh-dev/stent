/**
 * Node module-cache invalidation used by Stent's HMR integration.
 *
 * This module knows how to evict CommonJS and ESM module instances; the loader
 * supplies the callback that clears its per-installation transform marks. It
 * deliberately does not own patch state or hook registration.
 *
 * @module @oh-my-dsh/stent/hmr/reload
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Node's internal ESM loader surface used for load-cache eviction. */
interface InternalLoader {
  /** Node-internal ESM module cache, keyed by module URL. */
  readonly loadCache?: Map<string, unknown>
}

/** The `internal/modules/esm/loader` face reaching the cascaded loader. */
interface EsmLoaderModule {
  /** Node-internal accessor returning the process-wide cascaded loader. */
  readonly getOrInitializeCascadedLoader: () => unknown
}

/** Native addon face exposing Node's internal `requireBuiltin`. */
interface BuiltinRequirer {
  /** Load a Node-internal builtin module by its internal id. */
  readonly requireBuiltin: (id: string) => unknown
}

const loaderCache: { current?: InternalLoader } = {}

/** Narrow an addon export to the builtin-require face. */
function isBuiltinRequirer(value: unknown): value is BuiltinRequirer {
  return (
    typeof value === 'object'
    && value !== null
    && 'requireBuiltin' in value
    && typeof value.requireBuiltin === 'function'
  )
}

/** Narrow a builtin module export to Node's ESM loader module. */
function isEsmLoaderModule(value: unknown): value is EsmLoaderModule {
  return (
    typeof value === 'object'
    && value !== null
    && 'getOrInitializeCascadedLoader' in value
    && typeof value.getOrInitializeCascadedLoader === 'function'
  )
}

/** Narrow the cascaded loader to the surface this module reads. */
function isInternalLoader(value: unknown): value is InternalLoader {
  if (typeof value !== 'object') {
    return false
  }
  if (value === null) {
    return false
  }
  return true
}

/** Load Node's internal ESM loader module, or nothing when unavailable. */
function loadEsmLoaderModule(): unknown {
  try {
    const addon: unknown = require('node-addon-require-builtin')
    if (!isBuiltinRequirer(addon)) {
      return undefined
    }
    return addon.requireBuiltin('internal/modules/esm/loader')
  } catch {
    return undefined
  }
}

/** Ask Node's ESM loader module for the process-wide cascaded loader. */
function resolveInternalLoader(): InternalLoader | undefined {
  const loaderModule = loadEsmLoaderModule()
  if (!isEsmLoaderModule(loaderModule)) {
    return undefined
  }
  const loader = loaderModule.getOrInitializeCascadedLoader()
  if (!isInternalLoader(loader)) {
    return undefined
  }
  return loader
}

/** Locate Node's internal cascaded module loader when available. */
function internalLoader(): InternalLoader | undefined {
  const { current } = loaderCache
  if (current !== undefined) {
    return current
  }
  const loader = resolveInternalLoader()
  if (loader !== undefined) {
    loaderCache.current = loader
  }
  return loader
}

/** Return file-backed ESM module URLs currently held by Node's loader cache. */
function loadedEsmUrls(): string[] {
  const cache = internalLoader()?.loadCache
  if (cache === undefined) {
    return []
  }
  return [...cache.keys()].filter((url) => url.startsWith('file:'))
}

/**
 * Re-evaluate a CommonJS module after clearing both Node caches and the
 * loader's per-installation seen marks.
 */
function retransformCommonJs(
  filename: string,
  clearSeen: (filename: string) => void,
): unknown {
  delete require.cache[filename]
  const cache = internalLoader()?.loadCache
  if (cache) {
    Map.prototype.delete.call(cache, pathToFileURL(filename).href)
  }
  clearSeen(filename)
  return require(filename)
}

/** Node's internal ESM load cache, or a loud error when it is unavailable. */
function requireLoadCache(): Map<string, unknown> {
  const cache = internalLoader()?.loadCache
  if (cache === undefined) {
    throw new Error(
      'stent: ESM re-transformation requires the Node internal module loader (Node >= 22)',
    )
  }
  return cache
}

/** Path the loader marks as seen for a module URL. */
function seenPath(url: string): string {
  if (url.startsWith('file:')) {
    return fileURLToPath(url)
  }
  return url
}

/** Narrow an imported module namespace to a readable record. */
function isModuleNamespace(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object') {
    return false
  }
  if (value === null) {
    return false
  }
  return true
}

/** Import a module URL as a namespace object, without leaking `any`. */
async function importNamespace(url: string): Promise<Record<string, unknown>> {
  const namespace: unknown = await import(url)
  if (!isModuleNamespace(namespace)) {
    throw new Error(`stent: ${url} produced no ESM module namespace`)
  }
  return namespace
}

/**
 * Re-evaluate an ESM module after evicting Node's internal load cache. A failed
 * import restores the previous module job so the old instance remains usable,
 * matching the host HMR rollback contract.
 */
async function retransformEsm(
  url: string,
  clearSeen: (filename: string) => void,
): Promise<Record<string, unknown>> {
  const cache = requireLoadCache()
  const job: unknown = Map.prototype.get.call(cache, url)
  Map.prototype.delete.call(cache, url)
  clearSeen(seenPath(url))
  try {
    return await importNamespace(url)
  } catch (error) {
    if (job !== undefined) {
      Map.prototype.set.call(cache, url, job)
    }
    throw error
  }
}

export { loadedEsmUrls, retransformCommonJs, retransformEsm }
