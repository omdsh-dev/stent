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
import { pathToFileURL, fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Node's internal ESM loader surface used for load-cache eviction. */
interface InternalLoader {
  /** Node-internal ESM module cache, keyed by module URL. */
  readonly loadCache?: Map<string, unknown>
}

let cachedInternalLoader: InternalLoader | undefined

/** Locate Node's internal cascaded module loader when available. */
function internalLoader(): InternalLoader | undefined {
  if (cachedInternalLoader) {
    return cachedInternalLoader
  }
  let raw: { getOrInitializeCascadedLoader?: () => unknown } | undefined
  try {
    const addon = require('node-addon-require-builtin') as {
      requireBuiltin(id: string): unknown
    }
    raw = addon.requireBuiltin('internal/modules/esm/loader') as
      | { getOrInitializeCascadedLoader?: () => unknown }
      | undefined
  } catch {
    return undefined
  }
  const loader = raw?.getOrInitializeCascadedLoader?.() as
    | InternalLoader
    | undefined
  if (loader) {
    cachedInternalLoader = loader
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
  // oxlint-disable-next-line typescript/no-dynamic-delete -- require.cache eviction is the sanctioned invalidation API.
  delete require.cache[filename]
  const cache = internalLoader()?.loadCache
  if (cache) {
    Map.prototype.delete.call(cache, pathToFileURL(filename).href)
  }
  clearSeen(filename)
  return require(filename)
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
  const cache = internalLoader()?.loadCache
  if (!cache) {
    throw new Error(
      'stent: ESM re-transformation requires the Node internal module loader (Node >= 22)',
    )
  }
  const job: unknown = Map.prototype.get.call(cache, url)
  Map.prototype.delete.call(cache, url)
  let clearPath = url
  if (url.startsWith('file:')) {
    clearPath = fileURLToPath(url)
  }
  clearSeen(clearPath)
  try {
    return (await import(url)) as Record<string, unknown>
  } catch (error) {
    if (job !== undefined) {
      Map.prototype.set.call(cache, url, job)
    }
    throw error
  }
}

export { loadedEsmUrls, retransformCommonJs, retransformEsm }
