/**
 * Node-side materializer for the dsh closure-factory browser bundles.
 *
 * The web shell loads `/plugins/<id>/client.js` as a classic script: the
 * bundle only REGISTERS its factory via `window.__ModuleLoader__.load({id,
 * factory})` and every value import goes through the synchronous `require`
 * handed to the factory (the loader module table). Plain `import` of such a
 * bundle yields nothing, and node cannot synchronously `require` the ESM
 * platform seeds — so this helper mirrors the loader contract in tests:
 *
 *   1. `installModuleLoader()` installs the `window.__ModuleLoader__` sink
 *      (idempotent; run before any bundle executes, e.g. via setupFiles);
 *   2. `seed(...)` preloads the ESM platform seeds (cordis, ui-slots,
 *      primitives, react) into the module table via `await import`;
 *   3. importing a bundle's URL registers its factory, and
 *      `materialize(id)` executes it with the module-table require
 *      (recursing into other registered bundles, memoized).
 *
 * The environment must provide `window` (happy-dom) so the bundles can
 * execute their registration call.
 */

/** One registered closure-factory bundle: `factory(require) -> exports`. */
type Factory = (require: (spec: string) => unknown) => unknown

const factories = new Map<string, Factory>()
const seeds = new Map<string, unknown>()
const materialized = new Map<string, unknown>()

/** Install the `window.__ModuleLoader__` registration sink (once). */
function installModuleLoader(): void {
  const win = globalThis as typeof globalThis & {
    __ModuleLoader__?: { load(handoff: { id: string; factory: Factory }): void }
  }
  if (win.__ModuleLoader__ === undefined) {
    win.__ModuleLoader__ = {
      load: (handoff) => {
        if (factories.has(handoff.id)) {
          throw new Error(`duplicate factory registration for "${handoff.id}"`)
        }
        factories.set(handoff.id, handoff.factory)
      },
    }
  }
}

/** Preload platform seed modules (ESM namespaces) into the module table. */
async function seed(...specs: string[]): Promise<void> {
  for (const spec of specs) {
    if (seeds.has(spec)) continue
    seeds.set(spec, await import(spec))
  }
}

/** Inject explicit seed values (stubs for heavy render-only deps). */
export function seedMap(entries: Record<string, unknown>): void {
  for (const [spec, value] of Object.entries(entries)) seeds.set(spec, value)
}

/** Registration ids drop the `/client` suffix (mirrors client-modules). */
function stripClientSuffix(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

function resolve(spec: string): unknown {
  const id = stripClientSuffix(spec)
  if (factories.has(id)) return materialize(id)
  const seedModule = seeds.get(spec)
  if (seedModule !== undefined) return seedModule
  throw new Error(`client bundle module table miss: ${spec}`)
}

/**
 * Execute a registered factory with the module-table require.
 * @param id - the bundle registration id (package name, no `/client`).
 * @returns the factory's `module.exports`.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers provide the module table's typed view.
export function materialize<T>(id: string): T {
  const cached = materialized.get(id)
  if (cached !== undefined) return cached as T
  const factory = factories.get(id)
  if (factory === undefined) throw new Error(`no registered factory for "${id}"`)
  const exports = factory(spec => resolve(spec))
  materialized.set(id, exports)
  return exports as T
}

/** Convenience: seed the platform table and register the given bundle URLs. */
export async function prepareClientBundles(seedsList: string[], bundleUrls: string[]): Promise<void> {
  installModuleLoader()
  await seed(...seedsList)
  for (const url of bundleUrls) {
    await import(url)
  }
}

// Install the sink at module load: the client specs statically import this
// helper, so the sink exists before any closure-factory bundle executes its
// registration call (no separate vitest setupFiles needed).
installModuleLoader()
