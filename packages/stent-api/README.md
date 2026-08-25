# Cooperative Stent API layer

English | [中文](README.zh.md)

The cooperative Mod API is split across two packages: the pure compat facade in `stent-api` and the host-facing modules in `stent-dsh`. Together they provide a Stent-style API above the loader and Mixin subsystem — an optional library that is not mounted by the default host composition.

## What it does

Three layers make up the Stent-style extension architecture. The first two already exist; these packages are the third:

| Layer | Owner | Contract |
|---|---|---|
| Mod loader | Cordis Loader | Discovers configured plugins, resolves injection, mounts fibers, and disposes effects. |
| Mixin subsystem | `stent` | Transforms target code and dispatches trusted low-level patches. |
| Cooperative Mod API | `stent-api` + `stent-dsh` | Stable, domain-level registrations and events backed by existing host owners. |

A Mod remains an ordinary Cordis plugin that declares injection of only the Stent module services it consumes. Each facade delegates to the authoritative service — `ctx.tools`, `ctx.systemPrompt`, `ctx.commands`, the `agent/*` events, and the browser `ctx.command`/`ctx.slots` — and returns the exact disposer of the underlying effect. No facade stores a parallel copy of domain state, and none can bypass policy, approval, timeout, logging, cancellation, or the authoritative executor. The low-level `getStent(ctx)` accessor is launch-gated as well: if an un-declared dependency reaches it under plain `dsh`, it fails loudly instead of mounting the registry.

## Packages and modules

`stent-api` is a pure-Cordis peer library (it depends only on Cordis and `stent`):

| Entry | Service | Platform | Delegates to |
|---|---|---|---|
| `./compat/service` | `ctx.stentCompat` | Host | low-level `stent` patches (gap adapter) |

`stent-dsh` carries the host-coupled modules (its facades forward to the host through the real `@deepseek-ai/dsh-*` types, declared as peer dependencies):

| Entry | Service | Platform | Delegates to |
|---|---|---|---|
| `.` (Host bundle) | mounts all four Host modules | Host | the four entries below |
| `./host/agent` | `ctx.stentAgent` | Host | `agent/*` events and `agent.inject()` |
| `./host/tools` | `ctx.stentTools` | Host | `ctx.tools` and `tools/*` |
| `./host/prompt` | `ctx.stentPrompt` | Host | `ctx.systemPrompt` |
| `./host/commands` | `ctx.stentCommands` | Host | `ctx.commands` |
| `./browser/client` | `ctx.stentClient` | Web | `ctx.command` and `ctx.slots` |
| `./invariant` | invariant companion | Host | the host `invariants` service |
| `./bootstrap/profile` | `installStentBootstrap` | Host | composed profile rows → `stent` hooks |

The root entry of `stent-dsh` is the standard Host bundle; each new layer subpath is directly mountable for thin compositions. The browser entry remains `./client` because the client-module contract discovers that exact export; its implementation lives under `src/browser/client`. The old flat Host and compat subpaths are intentionally gone. Import the layer-specific entries above; no compatibility re-export modules are shipped.

## Installation

Mount the Host bundle (or one subpath) where the authoritative services are present:

```ts
import * as stentDsh from '@oh-my-dsh/stent-dsh'
import type { Context } from 'cordis'

declare const ctx: Context
await ctx.plugin(stentDsh)
```

```yaml
# User overlay: enable the Host bundle row.
- id: stent-dsh
  disabled: false
```

The compat facade is a peer library a Mod mounts itself (the bundle patch does not add a `stent-api` row):

```ts
import { StentCompatService } from '@oh-my-dsh/stent-api/compat/service'
```

A Mod declares only the modules it consumes:

```ts
import type { Context } from 'cordis'
import type { StentAgentService, StentPromptService } from '@oh-my-dsh/stent-dsh'

export const name = 'my-mod'
export const inject = ['stentAgent', 'stentPrompt']

export function apply(ctx: Context & { stentAgent: StentAgentService; stentPrompt: StentPromptService }): void {
  ctx.stentAgent.onStatus((agent, status) => {
    ctx.logger.info('agent %s is %s', agent.id, status)
  })
  ctx.stentPrompt.section({
    name: 'my-mod-identity',
    order: -80,
    text: 'my-mod is active',
  })
}
```

## Contracts

Every registration is a fiber effect: disposing the contributing plugin removes the contribution, matching the authoritative owner's disposal semantics (HMR-safe). Facade methods return the exact underlying disposer.

- **Agent API.** A stable subset of lifecycle observation (`onCreated`, `onDisposed`, `onStatus`) and operation-local context injection (`inject`). It never exposes the concrete loop, private queue state, or mutable session internals; callbacks receive the live Agent only where the owning event already does.
- **Tool API.** `register` and pre/post execution listeners through `ctx.tools`. A Stent tool has the same schema and result obligations as a native host tool, including model-visible logging and render intent. A waterfall listener must call `next()` unless it intentionally vetoes.
- **Prompt API.** Ordered system sections, cache-safe contexts, tool-schema providers, and prompt variables through `ctx.systemPrompt`. There is no shortcut that inserts unlogged model-visible text or assembles provider requests directly.
- **Command API.** Human commands through `ctx.commands`; commands remain outside model turns unless the owning contract starts one.
- **Compat API.** The cooperative entry for the low-level patch machinery. Two faces: `observe(name, listener)` keeps the static observation adapter for target domains with no cooperative extension point (targets declared in the module config, `buildCompatInstrumentations` produces the load-time instrumentations, and the public contract exposes only the declared target names). `registerPatch(patch)` / `unregisterPatch` / `disablePatch` / `enablePatch` open the full runtime patch surface — handlers bound at runtime to transforms the launcher bootstrap already installed (the profile's `config.stent.patches` stubs) — with an EXCLUSIVE id namespace: an id already claimed by a declared observation target or an earlier registration fails loud, and the low-level registry behind the facade additionally rejects an id owned by a different plugin, so exclusivity holds across facade instances. Registrations are owned by the plugin that mounted the facade; `unregisterPatch` disables AND removes the patch, freeing the id for a fresh ownership cycle. `serveBundle(options)` exposes the runtime browser-bundle primitive (`serveBrowserTransform`) so bundle rewrites also enter through the cooperative facade. All faces verify the bridge installation capability (`isStentInstalled`) and fail loud when the hooks are absent.
- **Client API.** Client commands and named UI slots through `ctx.command` and `ctx.slots`. The slot registration face is intentionally narrow (`StentSlotOptions`): the full SlotMap type machinery lives in the host slot service, whose declaration merging only sees the packages each consumer imports. `registerKeyedSlot(name, key, options, component)` adds ARBITRATION for keyed slots: the host invariant (one owner per key, loud on duplicates) stays, but the owner is decided by declared `priority` instead of mount timing — losing claimants queue and take over automatically when the owner disposes (`onGain`), a higher-priority claimant displaces the incumbent without force-disposing it (`onLost` informs it), and equal priorities keep registration order with a warning. Direct `ctx.slots.register` users still get the host throw.

The public surface exports no AST selector, module file path, `StentPatch`, raw bridge handle, or bypass around tool/command/prompt policy. Low-level patches remain the Mixin subsystem's escape hatch and are never part of this layer's contract.

## Profile bootstrap

`installStentBootstrap(rows)` reads the composed profile's `stent` row and installs its static patch descriptors from `config.stent.patches` by expanding them with `expandPatchStub` and passing them to `installStentHooks` during the boot `prepare` phase — before any target plugin module imports. `checkStentRequiredPatches(rows)` runs after boot completes and fails loud when a `required` patch bound nothing. Both are re-exported from `stent-dsh`.

## Security and trust model

- The cooperative layer is safe to grant more broadly than `ctx.stent`, but it is not automatically available to model-written temporary plugins: each facade reaches real process capabilities through its owning service, and repository/temporary-plugin policy grants modules explicitly.
- Missing required module services fail during Cordis activation (declared `inject`), and optional capabilities are read with `ctx.get()`.
- The facade never widens the authority of the service it delegates to.

## Platform support

- **Node Host:** the four Host modules and the profile bootstrap, via the authoritative Host services (the compat adapter additionally requires the Stent load-time hooks).
- **Browser/Web:** the `./client` entry mounts `ctx.stentClient` in the browser Cordis tree; the web roster rows are disabled by default (opt-in).

## Model Experience

Indirectly, through the authoritative owners it delegates to: tools, prompt sections, and command handlers registered through this layer are model-visible exactly as the owning registry makes them model-visible, and the session log reconstructs everything that reaches a model request.

#### KV Cache effect

None; the layer neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The facades are curated subsets, not complete mirrors.** A module enters the cooperative layer only when a real Mod consumer needs a compatibility boundary the domain service itself does not promise; the domain services remain the authoritative surface for everything else.
- **The client slot face is a narrow subset.** `ctx.stentClient.registerSlot` accepts a stable option shape (`StentSlotOptions`); declaration merging and composed-props inference stay in the host slot service, so a Mod that needs the full typed register contract uses that service directly.
- **The Cordis service catalog does not list the module services.** The catalog projector records service classes living in `src/index.ts` or `src/service.ts`; each module lives in its own entry file, so `ctx.stentAgent` and friends are documented here rather than in the generated catalog.
