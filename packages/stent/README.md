# `stent`

English | [中文](README.zh.md)

Stent/Mixin-style extension layer over Orchestrion-JS for trusted Cordis plugins. The service is opt-in: nothing in the default host composition mounts it, and patches register through trusted code.

## What it does

A trusted plugin (A) can change the behavior of another plugin's function (B) **without editing B's source**, by registering a Stent patch against B's module, file, and function:

| Operation | What the handler can do |
|---|---|
| `before` | Mutate the call arguments before the original body runs. |
| `after` | Observe or replace the successful result (including async results, after settlement). |
| `around` | Decide whether the original body runs and optionally replace its result (call `invoke()` to delegate). |
| `replace` | Own the call entirely; the original body only runs if the handler calls `invoke()`. |

The source is layered inside the three packages rather than adding another package. `stent/src/transform` is the single Orchestrion boundary: it owns the matcher adapter, instrumentation configuration, module identity, loader-thread wire serialization, and AST rewriting; `src/node` owns Node hooks and the compatibility entry points for Node subpaths; `src/browser` owns the public browser-transform facade, client runtime, and bundle serving; `src/hmr` owns HMR generation ownership and Node cache re-transformation; `src/testing` owns child-process fixtures. `stent-api/src/compat` separates the cooperative contract, instrumentation builder, and service. The companion integration package's `src/host`, `src/browser`, and `src/bootstrap` entries provide host facades, browser services, and profile assembly. Its catalog adapter is mounted by that companion package, so the pure Stent service has no catalog dependency.


## Installation and bootstrap

```ts
import { installStentHooks } from '@oh-my-dsh/stent/node/loader'
import { StentService } from '@oh-my-dsh/stent'
import type { Context } from 'cordis'

declare const ctx: Context
// The DSH launcher calls installStentHooks(). Plugin code supplies patch metadata
// and handlers later through ctx.stent.register().
const disposeHooks = installStentHooks()
await ctx.plugin(StentService)
disposeHooks()
```

`installStentHooks` has one Node installation path: `installStentHooks()`. It must run before target imports.
Dynamic mode subscribes to the process-local runtime registry and rebuilds its
matcher when plugin code registers or removes patch metadata; executable
handlers remain in memory and are never serialized. A target already loaded
when a plugin registers is automatically re-transformed when the Node cache
path supports it. Profile YAML only controls whether a Stent-dependent row is
mounted (for example `config: { stent: true }`); it no longer carries patch
stubs under `config.stent.patches`.
The root package's `patchInstrumentation`, `expandPatchStub`, and browser transform APIs are build-time/browser utilities; they do not install Node hooks and cannot be passed to `installStentHooks`.
The launcher boundary is separate from hook installation. The `stent-dsh` preload marks the launch before bootstrapping hooks; a plain `dsh` launch never receives that marker. `StentService` uses it as Cordis's availability check, so plugins declaring `inject: ['stent']` remain pending under plain `dsh` even if another path installed the low-level bridge. The browser client entry marks the equivalent Stent client activation. The same gate is enforced by `getStent(ctx)` before it reuses or mounts a registry: a DSH plugin that omitted `inject: ['stent']` cannot silently activate through the accessor and instead fails loudly. Explicit `new StentService(ctx)` remains the low-level escape hatch for standalone callers that intentionally manage activation themselves.

A patch may set `required: true`: once the application boots and every target
module has been imported, `checkRequiredPatches()` reads required entries from
the live runtime registry and fails loud when a required patch bound nothing.
The host runs this check automatically after boot. Several launch forms under
one patch id are covered by a RegExp `filePath` or by the `filePaths` array;
load-time bindings are recorded per transformed file and visible through
`ctx.stent.bindings(id?)` and each `list()` entry.

```yaml
# Profile YAML is an activation marker, not a patch descriptor source.
- id: dynamic-plugin
  disabled: true
  config:
    stent: true

- id: stent-dsh
  disabled: false
```

The host integration row mounts the Host facades. The core package's browser
half (`./client`, implemented by `src/browser/client`) is a separate client
artifact that installs `ctx.stent` when its browser entry materializes; it does
not turn the package root into a Loader plugin.

The dynamic hooks are installed before target imports. A patch registered before a
target load is transformed on first evaluation; if the target already ran, the
loader schedules a cache re-transformation for the loaded CJS/ESM module when
Node's synchronous hook APIs are available. Handler-only enable/disable changes
apply immediately through the bridge without another code transform. The
`registerHooks` API has no unregister, so a disposer deactivates installation
state rather than removing the process-lifetime hook functions.


## Registering a patch

```ts
import type { Context } from 'cordis'
import type { StentCall, StentService } from '@oh-my-dsh/stent'

export const inject = ['stent']

export function apply(ctx: Context & { stent: StentService }): void {
  ctx.stent.register({
    id: 'my-vendor/rewrite-greeting',
    target: {
      module: '@example/target-package',
      versionRange: '^1.0.0',
      filePath: 'lib/index.js',
      functionQuery: { functionName: 'greet', kind: 'Sync' },
    },
    operation: 'before',
    handler(call: StentCall) {
      call.arguments[0] = String(call.arguments[0]).toUpperCase()
    },
  })
}
```

The registration is a fiber effect owned by the registering plugin: disposing the plugin disables and removes the patch, and a patch id is exclusive to one owner — a different plugin claiming an already-registered id fails loud instead of silently overwriting the incumbent's hook. Every registration attaches its own disposal to the registering fiber, and the disposer only removes the entry while that fiber still owns it: a hot reload's new generation takes its plugin's patches back (same owner, transfer), so the old generation's unload becomes a no-op instead of unregistering the new generation's hooks. `ctx.stent.list()` returns an ordered diagnostic snapshot whose entries carry the patch's recorded load-time bindings; `ctx.stent.bindings(id?)` returns the binding records directly; `ctx.stent.disable(id)` / `ctx.stent.enable(id, handler)` toggle a patch without removing it, and `ctx.stent.remove(id)` removes it entirely. Plugins that cannot declare the optional service may call `getStent(ctx)`, but the accessor is still gated by the `stent-dsh` launch capability and fails loudly under plain `dsh`; declare `inject: ['stent']` for normal DSH plugins. Standalone callers that intentionally bypass the DSH launcher should construct `new StentService(ctx)` explicitly.

## Security and trust model

- Patch handlers are trusted code bound at registration time; executable handlers are never deserialized from YAML or model input.
- Transformed code has process-level authority inside the target module. `cordis_mount` temporary plugins and repository plugins must not receive Stent capability without an explicit grant.
- Ids must match `[A-Za-z0-9._:/+-]{1,120}` (they are embedded in diagnostics and generated code).
- Target validation is fail-loud: a malformed target (bad id, module, version range, file, operation, selector, or index) throws at registration instead of installing a config that never matches. A well-formed target that matches nothing — different installed version, different file layout — silently leaves the module untransformed; the matcher only rewrites what its selectors pick.
- A selector that picks several functions in one file rewrites every match by default (the upstream first-match-only default is flipped: `index: null`); pass a zero-based `index` (`target.index` for a raw `astQuery`, `functionQuery.index` for a name query) to rewrite a single match. Constructor targets are rejected loudly at transformation time — a moved constructor body cannot carry `super()` or `new.target` — so patch a method or factory instead.

## Platform support

- **Node Host (ESM + CommonJS):** supported via synchronous `module.registerHooks` (Node ≥ 22.22.3 / ≥ 24.11.1) and the CJS `_compile` path. Module identity resolves through the npm-layout parser first and falls back to the nearest `package.json` (`nodePackageResolver`) — Node realpaths workspace links, so a workspace package's loaded URL has no `node_modules` boundary for the layout parser to name, while the nearest manifest always can. This is what lets patches target first-party workspace packages (e.g. a host tool bundle) at their real paths. `registerHooks` exists from 22.19.0, but before 22.22.3 / 24.11.1 its synchronous load chain returns no source for CommonJS modules when loader-thread hooks (`module.register`, e.g. tsx on those versions) are also present, which crashes Node's load validation; those versions therefore use the async `module.register` fallback through the `node/hook-entry` loader-thread module. The entry is registered once and reads a shared configuration file (rewritten by the main thread on every installation and disposal) on each load, so re-transformation, disposal, and concurrent installations behave the same on both paths.
- **Browser/Web:** the bundle-time rewrite (`createWatchedBrowserTransform` (or `createBrowserTransform` for a static set) + `repoSourceResolver`, wired through `clientBundle(id, libEntry, { transform })`) rewrites client plugin functions, and the package's own client half (`./client`, implemented by `src/browser/client`) installs the bridge and mounts `ctx.stent` in the browser Cordis tree. Client bundles fall back to the original body until that entry materializes, so patches take effect for calls after the browser Stent runtime is up. The web roster row `stent` is disabled by default (opt-in).

## Browser build usage

The host build seam (`clientBundle`) is owned by the host version selected by the profile; this package only provides the transform. A host integration wires the transform into its bundle step:

```ts ignore-check
import { createWatchedBrowserTransform, repoSourceResolver } from '@oh-my-dsh/stent'

const stent = createWatchedBrowserTransform(
  new URL('./stent.patches.json', import.meta.url).pathname,
  repoSourceResolver('@example/client-my-plugin', new URL('..', import.meta.url).pathname, '0.0.1'),
)
```

The patches file holds a JSON array of static patch stubs for browser build
instrumentation (it is not read by the Node DSH launcher; JSON cannot express
a `RegExp` `filePath`, so file paths are strings), and a malformed file fails
the build loudly. The transform registers the file in the bundler's watch graph
on every module, so under `tsdown --watch` (`pnpm run dev:web`) an edit rebuilds
the bundle with the new patch set — the build trigger — and the client-hmr
chain delivers it to the browser. A static in-memory patch set can still use
`createBrowserTransform` directly.

The resolver maps the package's own source tree to its package identity; the upstream adapter is not used because it requires a `node_modules` boundary that repository source builds do not have. TypeScript sources are stripped to plain JavaScript before transformation (the transformer parses emitted JavaScript).

### Runtime bundle serving

When the target bundle cannot be transformed at build time (its build is owned by another package), `serveBrowserTransform(ctx, options)` serves a transformed copy at runtime: it registers an EXACT webserver route (the exact table wins before longest-prefix, so it outranks the module host's `/plugins` route without a conflict), resolves the patches' `module` package through the Loader composition anchor (`ctx.baseUrl`) rather than Stent's dependency tree, applies the patch rewrites per request under a source-content cache, answers 405 for non-GET and 404 for an unreadable bundle, and is loud by default when any selector rewrites nothing (500 naming every unbound patch id) — degrading to the raw bundle only with `fallback: 'raw'`. A missing composition anchor or unresolvable target package fails at registration. `patch` accepts one descriptor or an array: several patches stack on the same file exactly like Node-side patches (ascending priority wraps outermost), so several plugins can enhance the same bundle without owning it — the route stays single-owned, the rewrites stack. The route is a fiber effect; the returned disposer removes it immediately.

### Testing patches

The transformation hooks cannot be unregistered and transformed modules stay cached, so every patch scenario needs a fresh process. `runPatchFixture({ patches, entry, args })` from `stent/test/testkit` makes that mechanical: it spawns a child that bootstraps the patches, imports `entry` (whose default export runs with `args`), and returns `{ bindings, result, error, exitCode }` — the thrown error's message travels verbatim (the enriched-error assertions of a node-half spec need no hand-rolled child runner), and each patch's load-time binding records make an unbound patch visible in the same call.

## Model Experience

None, as this package is host-side load-time transformation and patch registry machinery; patches register through code, never through model-written configuration.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Hooks stay for the process lifetime, state does not.** `registerHooks` hooks compose and stay registered; the disposer removes the installation's state (hooks become pass-through, cached transformers are freed). Each installation captures its own state and transforms through its own matcher, so concurrent installations are isolated; the shared CommonJS `_compile` wrapper chains every active installation in installation order (mirroring the sync hook chain), and disposing an earlier one leaves later ones intact. The async `module.register` fallback reaches the same semantics through its shared configuration file: the single loader-thread entry reads the current installation stack on every load, so a disposed installation stops transforming ESM on the next evaluation. The pid-scoped configuration file is removed on process exit.
- **CommonJS and ESM modules re-transform on both hook paths.** An already-evaluated module can be re-evaluated under the current installation stack: `retransformCommonJs(filename)` drops the `require.cache` entry (and the same file's Node-internal `loadCache` entry, so both graphs observe the fresh evaluation) and seen marks, and `retransformEsm(url)` evicts the module's Node-internal `loadCache` entry (the same mechanism the vendored Loader's HMR uses) — the next `require()`/`import()` runs the hooks again with the current installation stack (the sync hooks read the main-thread stack; the async entry reads the shared configuration). An HMR cycle replaces an old installation by disposing it before re-evaluating, so the fresh module carries only the new instrumentation; the old exports object keeps the old transformation. A failed ESM re-import restores the evicted entry, so the previous instance survives instead of leaving the URL unevaluatable. ESM re-transformation requires Node ≥ 22 (the internal module loader); the async `module.register` fallback supports it too, since the loader thread re-reads the configuration on the re-import.
- **Multiple patches on one function stack by priority.** Instrumentations apply in ascending priority order, so a higher-priority handler runs first (the outermost layer); equal priorities keep installation order (the later instrumentation wraps the outermost layer, so its handler runs first). Across installations, nesting follows installation order on every hook path — the later installation wraps outermost regardless of priority — because the sync hooks, the CJS `_compile` wrapper, and the async loader-thread entry all chain transforms per installation. Two `replace` patches on the same target are rejected at registration.
- **Arrow targets support every parameter pattern** (identifiers, rest, defaults, and destructuring — the patterns bind their names before the injected statements run), and a body referencing the enclosing `arguments` object is preserved by capturing it first. An arrow whose parameter is literally named `arguments` (it would shadow that capture) is skipped. Generator functions transform through delegation: the traced generator is `yield*`-delegated on the no-handler and `before`/`around`-invoke paths, so iteration semantics survive; a handler-supplied replacement that is not iterable is returned directly. `after` observes the generator object before iteration (the operation cannot intercept between yields).
- **Node load-time transformation requires precompiled JavaScript.** The loader parses emitted JS; `.ts` sources passed raw to the Node load hook fail loudly. The browser build path strips TypeScript annotations (and JSX) before transformation.
