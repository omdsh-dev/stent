/**
 * Node-side materializer for the dsh closure-factory browser bundles.
 *
 * The web shell loads `/plugins/<id>/client.js` as a classic script: the bundle
 * only registers its factory via `window.__ModuleLoader__.load({id, factory})`
 * and every value import goes through the synchronous `require` handed to the
 * factory (the loader module table). Plain `import` of such a bundle yields
 * nothing, and node cannot synchronously `require` the ESM platform seeds — so
 * this helper mirrors the loader contract in tests:
 *
 * 1. `installModuleLoader()` installs the `window.__ModuleLoader__` sink
 *    (idempotent; run before any bundle executes, e.g. via setupFiles);
 * 2. `seed(...)` preloads the ESM platform seeds (cordis, ui-slots, primitives,
 *    react) into the module table via `await import`;
 * 3. Importing a bundle's URL registers its factory, and `materialize(id)`
 *    executes it with the module-table require (recursing into other registered
 *    bundles, memoized).
 *
 * The environment must provide `window` (happy-dom) so the bundles can execute
 * their registration call.
 */

import type { SlotRegistry as SlotRegistryClass } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandUiRuntime as CommandUiRuntimeClass } from '@deepseek-ai/dsh-client-ui-commands/client'

/** Typed view of the commands registry bundle. */
interface CommandUiModule extends Record<string, unknown> {
  readonly CommandUiRuntime: typeof CommandUiRuntimeClass
}

/** Typed view of the runtime registry bundle. */
interface SlotRegistryModule extends Record<string, unknown> {
  readonly SlotRegistry: typeof SlotRegistryClass
}

/** Whether the commands bundle exposes its runtime class. */
const isCommandUiModule = (
  value: Record<string, unknown>,
): value is CommandUiModule => typeof value.CommandUiRuntime === 'function'

/** Whether the runtime bundle exposes its slot registry class. */
const isSlotRegistryModule = (
  value: Record<string, unknown>,
): value is SlotRegistryModule => typeof value.SlotRegistry === 'function'

/** One registered closure-factory bundle: `factory(require) -> exports`. */
type Factory = (require: (spec: string) => unknown) => Record<string, unknown>

/** Registration handoff the window sink receives per bundle. */
interface ModuleLoaderHandoff {
  readonly id: string
  readonly factory: Factory
}

const factories = new Map<string, Factory>()
const seeds = new Map<string, unknown>()
const materialized = new Map<string, Record<string, unknown>>()

const MODULE_LOADER_KEY = '__ModuleLoader__'
const CLIENT_SUFFIX = '/client'
const FIRST_INDEX = 0

/** Install the `window.__ModuleLoader__` registration sink (once). */
function installModuleLoader(): void {
  const host = globalThis as Record<PropertyKey, unknown>
  host[MODULE_LOADER_KEY] ??= {
    load: (handoff: ModuleLoaderHandoff): void => {
      if (factories.has(handoff.id)) {
        throw new Error(`duplicate factory registration for "${handoff.id}"`)
      }
      factories.set(handoff.id, handoff.factory)
    },
  }
}

/** Preload platform seed modules (ESM namespaces) into the module table. */
async function seed(...specs: readonly string[]): Promise<void> {
  const pending = specs.filter((spec) => !seeds.has(spec))
  const modules = await Promise.all(
    pending.map(async (spec): Promise<readonly [string, unknown]> => [
      spec,
      await import(spec),
    ]),
  )
  for (const [spec, module] of modules) {
    seeds.set(spec, module)
  }
}

/** Inject explicit seed values (stubs for heavy render-only deps). */
function seedMap(entries: Readonly<Record<string, unknown>>): void {
  for (const [spec, value] of Object.entries(entries)) {
    seeds.set(spec, value)
  }
}

/** Registration ids drop the `/client` suffix (mirrors client-modules). */
function stripClientSuffix(spec: string): string {
  if (!spec.endsWith(CLIENT_SUFFIX)) {
    return spec
  }
  return spec.slice(FIRST_INDEX, spec.length - CLIENT_SUFFIX.length)
}

/**
 * Execute a registered factory with the module-table require.
 *
 * @param id - The bundle registration id (package name, no `/client`).
 * @returns The factory's `module.exports`.
 */
function materialize(id: string): Record<string, unknown> {
  const cached = materialized.get(id)
  if (cached !== undefined) {
    return cached
  }
  const factory = factories.get(id)
  if (factory === undefined) {
    throw new Error(`no registered factory for "${id}"`)
  }
  const exported = factory((spec) => {
    const bundleId = stripClientSuffix(spec)
    if (factories.has(bundleId)) {
      return materialize(bundleId)
    }
    const seedModule = seeds.get(spec)
    if (seedModule !== undefined) {
      return seedModule
    }
    throw new Error(`client bundle module table miss: ${spec}`)
  })
  materialized.set(id, exported)
  return exported
}

/**
 * Materialize a bundle and narrow it to the caller's typed view.
 *
 * @param id - The bundle registration id.
 * @param isModule - Guard that recognizes the expected export shape.
 * @returns The narrowed module exports.
 */
function materializeAs<TModule>(
  id: string,
  isModule: (
    value: Record<string, unknown>,
  ) => value is TModule & Record<string, unknown>,
): TModule {
  const exported = materialize(id)
  if (!isModule(exported)) {
    throw new Error(`bundle "${id}" does not expose the expected exports`)
  }
  return exported
}

/** Convenience: seed the platform table and register the given bundle URLs. */
async function prepareClientBundles(
  seedsList: readonly string[],
  bundleUrls: readonly string[],
): Promise<void> {
  installModuleLoader()
  await seed(...seedsList)
  await Promise.all(
    bundleUrls.map(async (url): Promise<unknown> => {
      const bundle: unknown = await import(url)
      return bundle
    }),
  )
}

export {
  isCommandUiModule,
  isSlotRegistryModule,
  materializeAs,
  prepareClientBundles,
  seedMap,
}
export type { CommandUiModule }
