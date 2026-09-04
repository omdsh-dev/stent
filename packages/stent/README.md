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

The source is layered inside the three packages rather than adding another package. The root entry contains only the platform-free runtime and service. Use `@oh-my-dsh/stent/loader` for Node hook lifecycle APIs, `@oh-my-dsh/stent/browser` for build-time transforms and runtime bundle serving, and `@oh-my-dsh/stent/client` for the browser Cordis entry. The Orchestrion adapter and its intermediate instrumentation types are implementation details under `packages/stent/src/transform`, not public API. `packages/stent/src/loader` is the single Node loader module: `loader.ts` coordinates installation, `state.ts` owns matcher snapshots, `sync.ts` and `async.ts` adapt Node hook APIs, `reload.ts` owns cache eviction, and `hook-entry.ts` owns the loader-thread entry. The `src/loader/index.ts` entry is the public loader API, while `packages/stent/src/browser` owns the build/runtime browser seams, `packages/stent/src/hmr` owns HMR generation ownership, cache operations live in the loader, and `packages/stent/src/testing` owns child-process fixtures. `packages/stent-api/src/compat` separates the cooperative contract and service. The companion integration package's host, browser, and bootstrap entries provide host facades, browser services, and profile assembly. For the transform boundary, data flow, and edge cases, see `packages/stent/docs/transform-api.md` and `packages/stent/docs/transform-architecture.md`. Its catalog adapter is mounted by that companion package, so the pure Stent service has no catalog dependency.
## Installation and bootstrap

```ts
import { installStentHooks } from '@oh-my-dsh/stent/loader'
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
The root entry contains only runtime and service APIs. Browser build APIs are imported from `@oh-my-dsh/stent/browser`; Node hook APIs are imported from `@oh-my-dsh/stent/loader`. Neither platform entry exposes Orchestrion's intermediate instrumentation configuration.
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
half (`./client`, implemented by `packages/stent/src/browser/client`) is a closure-factory
artifact loaded by the browser ModuleLoader (not a normal Node/ESM import); its
declaration file describes the source entry used to build that factory. It
installs `ctx.stent` when the browser entry materializes and does not turn the
package root into a Loader plugin.

The dynamic hooks are installed before target imports. A patch registered before a
target load is transformed on first evaluation. If the target already ran, the
synchronous path schedules cache re-transformation for loaded CJS/ESM modules;
the async `module.register` fallback handles future ESM loads in the loader thread,
while the main-thread CJS `_compile` wrapper and its re-transformation path remain
active. Handler-only enable/disable changes apply immediately through the bridge
without another code transform. The `registerHooks` API has no unregister, so a
disposer deactivates installation state rather than removing the process-lifetime
hook functions.
## Registering a patch

```ts
import type { Context } from 'cordis'
import type { StentCall, StentService } from '@oh-my-dsh/stent'

const inject = ['stent']

function apply(ctx: Context & { stent: StentService }): void {
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

export { inject, apply }
```

The registration is a fiber effect owned by the registering plugin: disposing the plugin disables and removes the patch, and a patch id is exclusive to one owner — a different plugin claiming an already-registered id fails loud instead of silently overwriting the incumbent's hook. Every registration attaches its own disposal to the registering fiber, and the disposer only removes the entry while that fiber still owns it: a hot reload's new generation takes its plugin's patches back (same owner, transfer), so the old generation's unload becomes a no-op instead of unregistering the new generation's hooks. `ctx.stent.list()` returns an ordered diagnostic snapshot whose entries carry the patch's recorded load-time bindings; `ctx.stent.bindings(id?)` returns the binding records directly; `ctx.stent.disable(id)` / `ctx.stent.enable(id, handler)` toggle a patch without removing it, and `ctx.stent.remove(id)` removes it entirely. Plugins that cannot declare the optional service may call `getStent(ctx)`, but the accessor is still gated by the `stent-dsh` launch capability and fails loudly under plain `dsh`; declare `inject: ['stent']` for normal DSH plugins. Standalone callers that intentionally bypass the DSH launcher should construct `new StentService(ctx)` explicitly.

## Security and trust model

- Patch handlers are trusted code bound at registration time; executable handlers are never deserialized from YAML or model input.
- Transformed code has process-level authority inside the target module. `cordis_mount` temporary plugins and repository plugins must not receive Stent capability without an explicit grant.
- Ids must match `[A-Za-z0-9._:/+-]{1,120}` (they are embedded in diagnostics and generated code). TypeScript callers must provide a string; the low-level regex guard coerces non-string JavaScript values, so do not rely on numeric or other values passing it.
- File selectors are literal matcher paths (normally package-relative by convention), not normalized paths: `filePath` may be empty, absolute, whitespace, or contain `..` without the static shape guard rejecting it; `filePaths` is a non-empty string array and expands one instrumentation per entry.
- Target validation is fail-loud in stages: static guards check module/version/file-selector/index/operation shapes, while `expandPatchStub` checks the id and builds the query; `required` is checked by Node startup binding logic but dropped from browser/internal transform configs. Query syntax is parsed only when a matching module is transformed, so malformed selectors can fail at transform time; a valid module/file miss returns the module unchanged. An empty `filePath` currently passes the static guard.
- A selector that picks several functions in one file rewrites every match by default (the upstream first-match-only default is flipped: `index: null`); pass a zero-based `index` (`target.index` for a raw `astQuery`, `functionQuery.index` for a name query) to rewrite a single match. Constructor targets are rejected loudly at transformation time — a moved constructor body cannot carry `super()` or `new.target` — so patch a method or factory instead.

## Platform support

- **Node Host (ESM + CommonJS):** supported via `@oh-my-dsh/stent/loader`. On Node
  versions with synchronous hooks (22.22.3+, 24.11.1+, or a later major),
  `module.registerHooks` and the CJS `_compile` wrapper read matcher state
  directly on the main thread; on the async `module.register` fallback, only ESM
  load transforms run in the private loader-thread entry and receive serialized
  instrumentation through a shared JSON file, while CJS remains on the
  main-thread `_compile` path. Module identity is resolved from the nearest
  `package.json`, which works for installed packages and workspace realpaths,
  including pnpm's isolated `node_modules` layout. `installStentHooks()` permits
  only one active dynamic installation and rejects a second active call; disposal
  deactivates its state while process-lifetime hook functions remain installed.
- **Browser/Web:** the bundle-time rewrite (`createWatchedBrowserTransform` (or `createBrowserTransform` for a static set) + `repoSourceResolver`, wired through `clientBundle(id, libEntry, { transform })`) rewrites client plugin functions, and the package's own client half (`./client`, implemented by `packages/stent/src/browser/client`) installs the bridge and mounts `ctx.stent` in the browser Cordis tree. Client bundles fall back to the original body until that entry materializes, so patches take effect for calls after the browser Stent runtime is up. The web roster row `stent` is disabled by default (opt-in).

## Browser build usage

The host build seam (`clientBundle`) is owned by the host version selected by the profile; this package only provides the transform. A host integration wires the transform into its bundle step:

```ts ignore-check
import { createWatchedBrowserTransform, repoSourceResolver } from '@oh-my-dsh/stent/browser'

const stent = createWatchedBrowserTransform({
  patchesPath: new URL('./stent.patches.json', import.meta.url).pathname,
  resolve: repoSourceResolver({
    packageName: '@example/client-my-plugin',
    packageRoot: new URL('..', import.meta.url).pathname,
    version: '0.0.1',
  }),
})
```

The patches file holds a JSON array of static patch stubs for browser build
instrumentation (it is not read by the Node DSH launcher; JSON cannot express
a `RegExp` `filePath`, so file paths are strings), and a malformed file fails
loudly when the transform callback reads it. The transform registers the file in the bundler's watch graph
on every module. An edit rebuilds any bundle whose host bundler honors the watch
hook and HMR chain; that build integration is the trigger for browser
re-transformation. A static in-memory patch set can still use
`createBrowserTransform` directly.

The resolver maps the package's own source tree to its package identity; use `repoSourceResolver` for repository source builds because their identity is declared by the host rather than inferred from a `node_modules` path. The built-in installed-package resolver locates the nearest package manifest directly, but it expects a filesystem-like id under an existing manifest and does not normalize virtual/query-suffixed ids. `.ts`/`.tsx` sources are transpiled with `ts.transpileModule` (including JSX, without type-checking) before transformation; other extensions must already be JavaScript.

### Runtime bundle serving

When the target bundle cannot be transformed at build time (its build is owned by another package), `serveBrowserTransform(ctx, options)` serves a transformed copy at runtime: it registers an EXACT webserver route (the exact table wins before longest-prefix, so it outranks the module host's `/plugins` route without a conflict), resolves the patches' `module` package through the Loader composition anchor (`ctx.baseUrl`) rather than Stent's dependency tree, applies the patch rewrites per request under a source-content cache, answers 405 for non-GET and 404 for an unreadable bundle, and is loud by default when any selector rewrites nothing (500 naming every unbound patch id) — degrading to the raw bundle only with `fallback: 'raw'`. A missing composition anchor or unresolvable target package fails at registration. `patches` accepts an array of descriptors: patches in that array stack on the same file with Node-side semantics (ascending priority wraps outermost). One route owner must aggregate all descriptors for a bundle; independent plugin calls to `serveBrowserTransform()` register duplicate exact routes and are normally rejected by the webserver. If the host supplies route composition, the host must perform that aggregation. The route is a fiber effect; the returned disposer removes it immediately.

### Testing patches

The transformation hooks cannot be unregistered and transformed modules stay cached, so every patch scenario needs a fresh process. `runPatchFixture({ patches, entry, args })` from `@oh-my-dsh/stent/testing` makes that mechanical: it spawns a child that bootstraps the patches, imports `entry` (whose default export runs with `args`), and returns `{ bindings, result, error, exitCode }` — the thrown error's message travels verbatim (the enriched-error assertions of a node-half spec need no hand-rolled child runner), and each patch's load-time binding records make an unbound patch visible in the same call.

## Model Experience

None, as this package is host-side load-time transformation and patch registry machinery; patches register through code, never through model-written configuration.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Hooks stay for the process lifetime, state does not.** `registerHooks` hooks compose and stay registered; the disposer removes the installation's state (hooks become pass-through, tracked transformers are freed). `installStentHooks()` allows only one active dynamic installation and rejects a second active call; after disposal a later installation can create a new state while old hook layers remain inert. The async `module.register` fallback reads the current single installation's shared configuration on each future ESM load, while the main-thread CJS `_compile` wrapper and dynamic CJS re-transformation remain active. The pid-scoped configuration file is removed on process exit.
- **CommonJS and ESM modules re-transform on both hook paths.** An already-evaluated module can be re-evaluated under the current installation: `retransformCommonJs(filename)` drops the `require.cache` entry (and the same file's Node-internal `loadCache` entry, so both graphs observe the fresh evaluation) and seen marks, and `retransformEsm(url)` evicts the module's Node-internal `loadCache` entry (the same mechanism the vendored Loader's HMR uses) — the next `require()`/`import()` runs the hooks again (the sync hooks use the current state; the async entry re-reads the shared configuration for ESM). An HMR cycle replaces an old state by disposing it before re-evaluating, so the fresh module carries only the new instrumentation; the old exports object keeps the old transformation. A failed ESM re-import restores the evicted entry, so the previous instance survives instead of leaving the URL unevaluatable. ESM re-transformation requires Node ≥ 22 (the internal module loader); the async `module.register` fallback supports it too.
- **Raw AST queries must exclude generated scaffolding.** A broad selector such as `astQuery: 'FunctionExpression'` can match the anonymous replay closure that Stent injects while Orchestrion is traversing the mutable AST, recursively wrapping new closures or timing out. Use precise name/ancestor/function-shape predicates and test raw selectors for recursion.
- **Multiple patches on one function stack by priority.** Instrumentations are sorted in ascending priority, so a higher-priority handler is outermost: `before`/`around`/`replace` enter it first, while `after` sees the result on the way back out. Equal-priority order is input order for one browser/static snapshot; the single active dynamic Node snapshot sorts patch ids. A second active `installStentHooks()` call is rejected, so separate active installations do not nest. Two `replace` patches on the same target are rejected at registration.
- **Arrow, ordinary-function, and generator targets have special replay semantics.** Arrow bridge arguments are a synthetic array rebuilt from bound parameters: defaults are materialized, rest is expanded, destructuring creates a partial object/array, and extra caller arguments or original object identity are not preserved. A structural `arguments` scan captures the enclosing value when it recognizes one; arrows with an `arguments` parameter are skipped. Ordinary replay builds its slice from the unshadowed `arguments` binding, so ordinary parameters or local declarations that shadow it are unsupported; the moved body also changes non-strict `arguments.callee`/`arguments.caller` identity. Generator functions use `yield*` delegation for iterable results; `after` observes the generator object before iteration, and a non-iterable handler replacement is returned directly. Replay also does not preserve `super` or `new.target`, and strict-CJS directives need care.
- **Node load-time versus browser build-time input.** The Node loader parses precompiled JavaScript; raw `.ts` sources passed to its load hook fail loudly. The browser build transform transpiles ids ending `.ts` or `.tsx` with `ts.transpileModule` (including JSX, without type-checking) before parsing; `.mts` and `.cts` are not handled by that branch.
