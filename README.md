# RFC: dsh-external-stent — repository purpose, architecture, and decision record

English | [中文](README.zh.md)

- Status: **living document** (each section records the decision and its history)
- Scope: this standalone Stent extension workspace
- Upstream anchors: deepseek-harness snapshots `7b9644f2` (0812) / `9f9e2782a4` (0813),
  fork tip `65bcaf9902` (`feat-stent`)

This document explains *why* this repository is shaped the way it is. Every
non-obvious arrangement below was reached through a concrete failure recorded
in the commit history; the sections follow the repository's evolution rather
than its file layout.

---

## 1. Purpose: an external Stent extension, not a fork

deepseek-harness is a private monorepo. The Stent/Mixin extension layer lives
there as three implementation packages, but a consumer cannot install them from
the registry. This repository externalizes those three packages and publishes
the `@oh-my-dsh/stent-pack` carrier so consumers can install the complete bundle
through the official plugin channel:

```
dsh plugin --profile <p> add @oh-my-dsh/stent-pack
```

**Boundary (hard rule):** the workspace contains exactly three complete
implementation packages — `stent` (pure transformation service),
`stent-api` (pure compat facade), and `stent-dsh` (DSH-facing
facades, invariant, profile bootstrap). The root `@oh-my-dsh/stent-pack` is a
separately publishable carrier, not a fourth implementation package. Anything
else — including the official `@deepseek-ai/dsh-tool-cordis` toolset — remains
an upstream dependency and is not republished here.

## 2. Host integration: launcher-provided wiring

The three packages install hooks and mount facades through the compiled launcher.
`src/stent-dsh.ts` compiles to `lib/stent-dsh.js`, while
`src/stent-dsh-preload.ts` compiles to `lib/stent-dsh-preload.js`. The bin only
resolves the DSH path and forwards its arguments; it injects the compiled
preload through `NODE_OPTIONS=--import ...` before the official CLI loads. The
preload owns profile composition, dependency healing, argv normalization,
environment setup, and hook registration. No host patch checkout is required.
The preload also records a process-local `stent-dsh`
launch capability, so Stent-dependent plugins stay unavailable under plain
`dsh` even if low-level hooks were installed by another path. The same
capability gate is enforced by `getStent(ctx)`: a plugin that omitted
`inject: ['stent']` cannot mount the registry through the accessor under plain
`dsh` and fails loudly instead.

Everything the official channels already cover is deliberately excluded:
installing the trio (`dsh plugin add`), bundle roster rows and dependencies,
catalog generation, invariant/gate exemptions for trio-in-workspace, and all
documentation (`README*`, `docs/`, `.agents/`). What remains is what no
channel can provide: the launcher-owned preload/bootstrap and its tests, the
`clientBundle` source-transform build seam, catalog entries compiled into the
official `tool-cordis` package, and the pnpm-policy seams.

### 2.1 The disabled opt-in rows

The web-app bundle layer inserts the `stent` / `stent-dsh` rows as
**disabled opt-ins**. A dynamic patch plugin marks its row with a Stent
configuration marker (for example `config: { stent: true }`); the launcher
only uses that marker to enable the row through a generated overlay. It never
extracts patch metadata from YAML. Plugin code registers the target metadata
and executable handler through `ctx.stent.register()` after `installStentHooks()` has
been installed. Plain `dsh` leaves these rows disabled.

### 2.2 Dynamic patch registration

The Node launcher installs `installStentHooks()` before the
official CLI imports target plugins. A plugin's `ctx.stent.register({ id,
target, operation, priority, required, handler })` call is the single source of
truth for a patch: runtime metadata updates the loader matcher, while the
handler remains in process memory and is never serialized. New imports use the
new matcher immediately. If a target was already loaded, the loader schedules
CJS/ESM cache re-transformation under the new matcher when the synchronous Node
hooks are available; an async loader-thread fallback applies the update to
future ESM loads.

Removing a patch refreshes the matcher and re-transforms loaded targets when
possible. Enabling or disabling a handler does not need a code transform,
because transformed bridge calls dispatch against the live runtime registry.
`required: true` is checked from the runtime registry after boot, not from a
YAML descriptor list. Profile YAML may mark a row as Stent-dependent for
activation, but it must not contain `config.stent.patches` descriptors.
### 2.3 Public API boundaries

The `@oh-my-dsh/stent` package is intentionally split by platform:

- `@oh-my-dsh/stent` — platform-free runtime, bridge, service, and patch types;
- `@oh-my-dsh/stent/node` — Node hook installation, binding flush, and cache re-transformation;
- `@oh-my-dsh/stent/browser` — build transforms, package identity resolvers, and runtime bundle serving;
- `@oh-my-dsh/stent/client` — browser Cordis client artifact;
- `@oh-my-dsh/stent/testing` — isolated child-process fixtures.

Orchestrion configuration, wire serialization, module identity internals, and
loader-thread implementation remain private under `packages/stent/src/transform`
and `packages/stent/src/node`. Browser transforms accept public `StentPatchStub`
arrays and convert them internally; Node hooks read only the live runtime
registry. The package no longer exports platform implementation files as
compatibility subpaths.

### 2.4 The TSX dead end (recorded and reverted)

The `dsh` source launch (`node --import tsx/esm apps/cli/src/bin.ts`) once
appeared to need `TSX_TSCONFIG_PATH` or a register preload: `FiberState` (a
const enum, only in `vendor/cordis/src`) failed to resolve. Both workarounds
shipped and were then **reverted** — the real cause was a stale
`TSX_TSCONFIG_PATH` in the shell pointing at an old staging checkout. With a
clean environment tsx auto-discovers the entry's tsconfig (extending the base)
and resolves the aliases to `src`. The official script runs unchanged; no
host-specific workaround is required.

## 3. Install model: npm bundle

The publishable root bundle `@oh-my-dsh/stent-pack` declares the three published
npm implementation packages:

```
@oh-my-dsh/stent@^0.1.1
@oh-my-dsh/stent-api@^0.1.1
@oh-my-dsh/stent-dsh@^0.1.1
```

The same tag workflow publishes the root carrier after those three packages,
so its semver dependencies already exist on npm.

This keeps installation to one npm package:

```sh
dsh plugin --profile web add @oh-my-dsh/stent-pack
```

At installation, pnpm resolves those npm semver dependencies. At launch, `stent-dsh` asks DSH's module-fallback healer to map the bundle's dependency closure into `$DSH_HOME/profiles/node_modules`, so the Profile and the preload resolve the same trio copies.

- Host source installs declare the bundle in `apps/cli/package.json`; run the
  harness workspace's `pnpm install` and `pnpm run pack:build`, then install the
  published npm bundle through the plugin channel (joining `@oh-my-dsh/stent-pack` to
  `dsh.profile.bundles`). A profile boot through the compiled `lib/stent-dsh.js`
  enables the integration row through its generated overlay.
- Consumer-side builds use the explicit root `pack:build` script. The trio and the
  launcher are built with their package-owned tsdown commands before packing; no
  install-time prepare build is required.

### 3.1 pnpm 11 supply-chain seams

The npm bundle does not require `blockExoticSubdeps: false`, a Git
prepare allowlist, or `dangerouslyAllowAllBuilds` in the Profile. The workspace
still allows the native `esbuild` build and excludes the fast-moving DSH rc
train from minimum-release-age checks:

- `allowBuilds: esbuild` in this workspace;
- `minimumReleaseAgeExclude: ['@deepseek-ai/dsh-*']` — the dsh-* rc train ships
  inside the 24h window and a name-only entry exempts all versions.

## 4. Registry dependency policy

The dsh-* host packages publish fast rc trains; this repository tracks them
through registry ranges, and each lesson below came from a real breakage.

### 4.1 The dsh-compact trap

`@deepseek-ai/dsh-client-runtime@0.0.1-rc.1` depended on
`@deepseek-ai/dsh-compact`, which was **never published** (upstream deleted the
package after publishing that runtime). The `0.1.0-rc.x` series dropped the
dependency; verified installable end-to-end.

### 4.2 The missing rc.5

Upstream code is versioned `0.1.0-rc.5`, but the registry jumps
`rc.3 → rc.6` — rc.5 was never published. Ranges therefore read `^0.1.0-rc.0`
(resolving the newest published rc, and `rc.0` keeps stable releases in range
too). Peers use the same range, which the host workspace's rc.5 satisfies —
host installs reuse workspace packages instead of registry copies.

### 4.3 Real host types, not a local contract

The trio once declared a `host-contracts.ts` facade plus a global
`@deepseek-ai/cordis` Events injection. That broke type-checking across host
packages and was deleted in favor of importing the real `@deepseek-ai/dsh-*`
types (declared as peers + devDeps) — exactly the upstream shape. `ctx.slots`
typing comes from `dsh-client-runtime`'s declaration, as upstream.

### 4.4 Runtime peers of the published libs

With `autoInstallPeers: false`, the published `dsh-*` libs' load-time imports
(`dsh-scope`, `dsh-llm`, `dsh-timeout`, `dsh-typert-protocol`) must be listed
as devDependencies explicitly — each was added after a "Cannot find package"
at test load.

## 5. Browser client format: the closure factory

The web shell loads `/plugins/<id>/client.js` as a classic script and resolves
value imports through the loader module table (a synchronous `require` inside
the factory). Plain ESM bundles cannot load there at all. Consequently both
trio browser halves ship as closure factories:

```js
window.__ModuleLoader__.load({ id: "@oh-my-dsh/stent", factory: (require) => { ...; return module.exports; } })
```

with `@deepseek-ai/cordis` external (a platform seed) and everything else
inlined. `stent` was converted first; `stent-dsh` followed
(the same gap, fixed after the ex-setting install exposed the first one).
Upstream never notices this — its monorepo builds both through the shared
`clientBundle()` preset.

### 5.1 ex-setting's three lessons (same contract, external repo)

The sibling `omdsh-dev/ex-setting` bundle hit the same contract three times:

1. Its `dsh.client` manifest must be **nested** (`"dsh": { "client": ... }`),
   not a top-level `dshClient` field — client-modules scans the nested form;
2. its consumer-side build must use the **prepare config**, not just the local
   one, or git installs serve the old artifact;
3. cross-bundle value imports must not rely on a disabled row's factory —
   ex-setting inlines/avoids what the module table cannot answer, and installs
   static styles directly instead of routing them through a Stent publish the
   transform could not produce (browser-transform cannot match inside the
   closure artifact).

## 6. Test strategy

The upstream suite resolves `src` through tsconfig paths; this repository only
has registry `lib` artifacts, which drove the evolution below.

- **serve.spec** uses a test-local `node:http` adapter for the host `webServer`
  service, so exact/prefix routing and real HTTP responses stay covered without
  a DSH host-webserver test dependency.
- **hmr-e2e-runner** drives config HMR by toggling the row's `disabled` flag
  in `cordis.yml`: the vendored fork's `hmr.registerConfig` and include
  `internal/update` are fork-private and exist in **no** registry version
  (verified against latest 1.0.16/1.0.6).
- **client specs** originally faked `CommandUiRuntime`/`SlotRegistry` because
  the runtime rc.1 tree was uninstallable and the bundles are closure
  factories. After rc.6 became installable the real reason remained the
  factory format, so the specs now mount the **real services** through a test
  module loader (`packages/stent-dsh/tests/browser/module-loader.ts`): happy-dom provides `window`; the
  `__ModuleLoader__` sink installs at helper module load; platform seeds
  (`cordis`, `ui-slots`, `react`) preload as ESM namespaces (the factory
  `require` is synchronous and node cannot `require` ESM);
  `ui-primitives` — a render-only heavy package — is stubbed; `materialize()`
  executes a factory with the module-table require (recursing into other
  registered bundles, memoized, `stripClientSuffix` normalizing `pkg/client`).
  Loader `baseUrl` and fixture URLs are pinned to file paths because
  happy-dom's `location` is `http://localhost:3000`.

## 7. Linting

Each package runs Oxlint from its own package root with the pinned DSH toolchain (`oxlint` plus `oxlint-tsgolint`) and selected type-aware TypeScript rules; the root and package configs share a checked-in baseline. Warnings are failures. Every control statement must use braces (`curly: all`). Generated `lib/` output, JavaScript fixture launchers, and build configs stay outside this TypeScript lint face.

The shared source override also loads `tools/oxlint/stent-plugin.ts` and enables `stent/comment-shorter-than-function` and `stent/min-function-lines`. The comment rule reports when a contiguous documentation block directly preceding a function has at least as many meaningful lines as the function's effective implementation; this treats an over-documented function as a candidate for removal or simplification. It ignores blank-line-separated headers, inline comments, function-body comments, and lint/compiler directives. Exported functions and anonymous callbacks are skipped by default because public API documentation and callback context may legitimately need more explanation; `includeExported` and `includeAnonymous` opt them in. By default, block-comment delimiters and JSDoc decoration do not count; `countCommentDelimiters` enables physical nonblank comment-line counting. The function rule counts effective source lines, including the function definition line; blank and comment-only lines are ignored. Its baseline thresholds are `declaration: 5`, `expression: 3`, `method: 2`, and `arrow: 3`. The `minimums` option independently configures each syntax; an integer sets that syntax's threshold and `false` disables it. Intentional short adapters must use `// oxlint-disable-next-line stent/min-function-lines -- reason` with an explanation.

Oxfmt is the workspace formatter, with the shared policy in `.oxfmtrc.json`: two-space indentation, single quotes in JavaScript and TypeScript, single quotes in JSX attributes, no semicolons, all trailing commas, and an 80-column print width. Each package owns its `fmt` and `fmt:check` commands; the carrier root's `pack:fmt:check` orchestrates the check across the root and all implementation packages. Generated `lib/` output, fixture trees, JavaScript launcher fixtures, and build configs remain outside the formatting face.

The carrier root owns the launcher under `src/`, the root integration tests under `tests/`, and the project-local lint plugin under `tools/`. Its `lint`, `lint:fix`, `test`, `build`, and `knip` commands never scan implementation package files; it has no `pack:lint:fix` command. Each implementation package declares its own toolchain and exposes independent `lint`, `lint:fix`, `test`, `build`, and `knip` commands scoped to that package; type checking is provided by each package's type-aware lint command rather than a separate `typecheck` script. The `pack:*` scripts at the carrier root are orchestration only: they keep the root-package checks separate from the package-owned commands and invoke the latter with `pnpm --filter`.

## 8. Timeline (abridged)

| Commit | Decision |
|---|---|
| `1e04b1a`..`2a42254` | externalization: standalone Stent bundle, self-contained template |
| `4018661`, `8ffaac4` | port the upstream three-package split + full host patch; HMR e2e |
| `d9228c4`, `40600d4` | official plugin channel install; source-host install script |
| `1ba7077`, `3331b80` | web-app bundle composes the rows; rows become disabled opt-ins |
| `7b8e913`, `3fd3106` | patch rebases: 0812 baseline → 0813 baseline |
| `9158f5d` | delete `host-contracts.ts`; real `@deepseek-ai/dsh-*` types |
| `30ed5ff`, `b58c643` | registry dependency policy (rc.5 peer, installable suites) |
| `58fbe75`, `33955ef` | both browser halves become closure factories |
| `aa58a52` | publish publicly (upstream parity) |
| `62ced22` | revert the TSX workarounds (environment misdiagnosis) |
| `3fd1a56` | happy-dom + ModuleLoader materializer; real browser services in tests |

## 9. Future work

- If the registry ever publishes node-importable builds (plain ESM or the
  `src` halves), the test module loader disappears and the specs import
  packages directly.
- Upstream promoting `createSnapshotStore` out of `dsh-client-runtime` shrinks
  the seed table.
- Upstream publishing `hmr.registerConfig` / `internal/update` would let the
  HMR runner mirror the in-tree config flow again.
