/**
 * The catalog adapter belongs to the DSH integration layer: the pure Stent
 * package has no dependency on the host's tool-cordis catalog.
 *
 * @module @oh-my-dsh/stent-dsh/catalog
 */

import { STENT_CATALOG_ENTRIES } from '#src/catalog-entries'
import type { CatalogEntry } from '#src/catalog-types'

/** Compute the official catalog comparison key for one entry. */
const catalogEntryKey = (entry: CatalogEntry): string => {
  if ('key' in entry) {
    return `key:${entry.key}`
  }
  return `name:${entry.name}`
}

interface ApiCatalogModule {
  SERVICE_API?: CatalogEntry[]
}

/** Narrow a dynamic import result to the official catalog module shape. */
const isApiCatalogModule = (value: unknown): value is ApiCatalogModule => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return 'SERVICE_API' in value && Array.isArray(value.SERVICE_API)
}

/** Push the stent entries into the official catalog once (idempotent). */
async function registerCatalogEntries(): Promise<void> {
  try {
    /* Variable specifier: the official package is host-provided only, never
       a trio dependency, so the import stays out of the type graph. */
    const spec = '@deepseek-ai/dsh-tool-cordis/src/api-catalog.ts'
    const module: unknown = await import(spec)
    if (isApiCatalogModule(module)) {
      const list = module.SERVICE_API
      if (list !== undefined) {
        list.push(
          ...STENT_CATALOG_ENTRIES.filter(
            (entry) =>
              !list.some(
                (existing) =>
                  catalogEntryKey(existing) === catalogEntryKey(entry),
              ),
          ),
        )
      }
    }
  } catch {
    /* Built host (no tsx, no ./src/* resolution): the inspect report still
       lists the live stent services, just without signatures. */
  }
}

export { registerCatalogEntries }
export { STENT_CATALOG_ENTRIES } from '#src/catalog-entries'
