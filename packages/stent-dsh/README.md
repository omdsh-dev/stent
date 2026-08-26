# `stent-dsh`

English | [中文](README.zh.md)

DSH-facing integration for the Cordis Stent layer. This package is the host
and browser assembly half of Stent: it mounts the DSH facades, reads composed
profile rows for activation, installs the pure `stent` dynamic hooks before
target modules are loaded, and verifies required patch bindings after boot.

It is intentionally separate from the pure packages. `stent` owns
transformation and runtime state; `stent-api` owns the cooperative
compat contract; this package delegates to the authoritative DSH services and
owns only the DSH integration seams.

## What it provides

| Layer | Responsibility |
|---|---|
| Host facades | `ctx.stentAgent`, `ctx.stentTools`, `ctx.stentPrompt`, and `ctx.stentCommands`, backed by the authoritative DSH services. |
| Browser facade | `ctx.stentClient`, a narrow Mod-facing surface for commands and named UI slots. |
| Profile bootstrap | `installStentBootstrap` calls `installStentHooks()` for embedders without the launcher; `checkStentRequiredPatches` validates live required bindings after boot. |
| Catalog adapter | Registers the Stent service API entries when the DSH integration plugin mounts. |
| Invariant companion | Exposes the package-owned `./invariant` function plugin; domain ownership remains with the authoritative services. |

Every facade returns the underlying service's disposer and keeps registration
scoped to the contributing Cordis fiber. The package does not maintain a
parallel copy of host domain state and does not bypass host policy, logging,
approval, cancellation, or execution semantics.

## Host entry

The root entry is a named-export Cordis plugin; it has no default export:

```ts
import * as StentDsh from '@oh-my-dsh/stent-dsh'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
await ctx.plugin(StentDsh)
```

The root plugin mounts all four Host facades. Consumers that need one module
can import the corresponding `./host/*` entry instead. The function-plugin
namespace preserves the named exports `name`, `inject`, and `apply`.

## Profile bootstrap

The launcher enables Stent-dependent rows through a generated overlay, but the
rows contain only activation metadata. Plugin code registers both the target
metadata and handler through `ctx.stent.register()`; no patch descriptor is
read from YAML. Keep a dynamic patch plugin disabled by default when it should
be opt-in:

```yaml
- id: dynamic-plugin
  disabled: true
  config:
    stent: true

- id: stent-dsh
  disabled: false
```

`installStentBootstrap(rows)` is the profile-bootstrap API for embedders that
compose a profile without `stent-dsh`'s launcher preload; it calls
`installStentHooks()` before target modules are imported. In the launcher path, the preload performs that installation
before the target CLI imports modules. `checkStentRequiredPatches(rows)` runs
after boot and checks required entries in the live runtime registry. The
preload's process-local launch capability is separate from hook installation,
so merely installing the bridge cannot activate a Stent-dependent plugin. The
low-level `getStent(ctx)` fallback checks the same capability before mounting a
registry, so plugins that omitted `inject: ['stent']` fail loudly rather than
bypassing the launch gate.

## Browser entry

The browser facade is available from both of these package contracts:

- `stent-dsh/browser/client` — the logical layered source entry;
- `stent-dsh/client` — the direct closure-factory artifact discovered by
  DSH client-module infrastructure.

`./client` is a required build contract, not a compatibility source shim. Both
entries expose the same browser facade. The facade delegates to the real DSH
command and slot services and intentionally narrows the slot registration
shape; consumers that need the complete SlotMap type should use the
authoritative DSH slot service.

## Public entries

| Entry | Purpose |
|---|---|
| `stent-dsh` | Mount all Host facades and schedule required-patch verification. |
| `stent-dsh/host/agent` | Agent lifecycle observation and operation-local injection. |
| `stent-dsh/host/tools` | Tool registration and execution listeners. |
| `stent-dsh/host/prompt` | Prompt sections, contexts, variables, and tool-schema providers. |
| `stent-dsh/host/commands` | Human command registration. |
| `stent-dsh/browser/client` | Browser commands and named UI slots. |
| `stent-dsh/bootstrap/profile` | Profile bootstrap and required-patch checks. |
| `stent-dsh/invariant` | Package invariant companion plugin. |

## Runtime requirements

`stent-dsh` uses registry-installable DSH host packages as peer
contracts. The consuming DSH profile must provide the authoritative services
and the matching `stent` installation. Cross-package development in
this repository uses the workspace protocol; published peers remain registry
semver ranges.

The package is opt-in. The default DSH composition does not mount these
facades, and the browser roster rows remain disabled. A host profile launched
through `stent-dsh` enables the host integration and Stent-dependent plugin rows
whose config carries the activation marker.
