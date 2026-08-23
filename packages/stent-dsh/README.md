# `stent-dsh`

English | [中文](README.zh.md)

DSH-facing integration for the Cordis Stent layer. This package is the host
and browser assembly half of Stent: it mounts the DSH facades, reads composed
profile rows, installs the pure `stent` hooks before target modules are
loaded, and verifies required patch bindings after boot.

It is intentionally separate from the pure packages. `stent` owns
transformation and runtime state; `stent-api` owns the cooperative
compat contract; this package delegates to the authoritative DSH services and
owns only the DSH integration seams.

## What it provides

| Layer | Responsibility |
|---|---|
| Host facades | `ctx.stentAgent`, `ctx.stentTools`, `ctx.stentPrompt`, and `ctx.stentCommands`, backed by the authoritative DSH services. |
| Browser facade | `ctx.stentClient`, a narrow Mod-facing surface for commands and named UI slots. |
| Profile bootstrap | `installStentBootstrap` installs Stent hooks from the composed `stent` row before target imports; `checkStentRequiredPatches` validates required bindings after boot. |
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

The pure `stent` row is the descriptor carrier. Keep that row disabled:
the package root is a service library, not a Loader plugin. The Stent launcher
reads its `config.stent.patches` and installs the hooks through its preload.
Enable the DSH integration row separately:

```yaml
- id: stent
  disabled: true
  config:
    stent:
      patches:
        - id: vendor/rewrite-greeting
          target:
            module: '@example/target-package'
            versionRange: '^1.0.0'
            filePath: 'lib/index.js'
            functionQuery: { functionName: greet, kind: Sync }
          operation: before

- id: stent-dsh
  disabled: false
```

`installStentBootstrap(rows)` is the profile-bootstrap API for the same
composed descriptors; in the current launcher path, the preload performs the
installation before the target CLI imports modules. Handlers remain trusted
runtime code registered by plugins. Patch descriptors must be declared under
`config.stent.patches`.

`checkStentRequiredPatches(rows)` runs after boot and fails loudly when a
`required: true` patch did not bind. The launcher schedules this check for the
composed profile; a plain `dsh` launch remains inert unless the Stent launch
path is enabled. The preload's process-local launch capability is separate
from hook installation, so merely installing the bridge cannot activate a
Stent-dependent plugin. The low-level `getStent(ctx)` fallback checks the same
capability before mounting a registry, so plugins that omitted
`inject: ['stent']` fail loudly rather than bypassing the launch gate.

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
facades, and the browser roster rows remain disabled until the Stent launch
path enables them.
