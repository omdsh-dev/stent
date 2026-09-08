---
name: node-import-esm-loader
description: Use when designing, implementing, debugging, or reviewing a Node.js --import ESM preload module with resolve/load hooks, source transformation, URL-aware resolution, CommonJS interoperability, Node-version feature detection, source maps, hook composition, or registration teardown.
---

# Node.js --import ESM loader

## Summary

Use this skill to build a production-grade Node.js ESM customization module loaded with node --import <specifier>. Treat the preload as a chain participant, not as a replacement for Node's resolver: delegate to Node at the defined points, preserve its format and URL metadata, transform only owned files, and make every registration independently disposable.

This guidance is distilled from the tsx project, a production Node.js --import ESM loader. Primary sources there are src/esm/index.ts, src/esm/api/register.ts, src/esm/hook/initialize.ts, src/esm/hook/resolve.ts, and src/esm/hook/load.ts. Behavioral sources are tests/specs/esm-hook-resolve.ts, tests/specs/loaders.ts, tests/specs/version-sensitive.ts, and docs/dev-api/node-cli.md.

## Decision tree

- **Application or process-wide preload:** prefer visible node --import <package> app.mjs. NODE_OPTIONS=--import <package> is useful when another tool launches Node.
- **Module-only preload:** use a dedicated ESM entry such as package/esm when CJS patching is not wanted.
- **Entry-owned runtime setup:** import the ESM entry only when the entry file owns the behavior. Static imports evaluated before registration are not enhanced; use a later dynamic import.
- **Scoped dynamic loading:** expose register() and an unregister function when a library must install hooks temporarily. Use a namespace for multiple independent registrations.
- **One-shot loading:** expose a tsImport-like API when one config or plugin file must load TypeScript without changing the whole process or sharing module cache.
- **Older Node:** document the deprecated --loader fallback separately. Do not claim that --loader and --import have identical lifecycle behavior.

## The loader contract

A --import package has two jobs:

1. Its preload entry runs before the application and registers supported module hooks.
2. Its hook entry exports initialize, resolve, and load, with globalPreload only for the older hook protocol.

Make the package boundary explicit: type module, stable ESM exports, declared Node engine range, and a separate CJS entry only when CJS is a supported product surface. tsx publishes distinct root, esm, cjs, and API entries in package.json.

Each hook receives a nextResolve or nextLoad continuation. Returning without calling it is a deliberate short-circuit. Every hook therefore needs an ownership predicate and a pass-through path:

~~~js
if (!isOwnedRequest(specifier, context)) {
  return nextResolve(specifier, context)
}
~~~

Do not assume the hook is alone. Import order changes whether another observer sees the original or transformed result. Test both orders.

## Architecture

Separate four layers:

- **Entry:** preload detection, hook exports, and imports compatible with the minimum Node.
- **Registration:** sync versus async API selection, initialization data, optional CJS interop, source-map state, and disposal.
- **Hooks:** per-registration state, resolution, format decisions, loading, transformation, URL identity, and diagnostics.
- **Support:** compiler options, capability ranges, URL utilities, caches, source maps, and protocol messages.

Create mutable state in the hook entry itself. Node's module.register path can load a cache-busted copy per registration while bundler-hoisted helper modules are shared. A singleton state object therefore lets registrations overwrite each other's namespace or active flag. Workers also require isolated state.

~~~ts
type HookData = {
  active: boolean
  namespace?: string
  tsconfig?: unknown
  port?: MessagePort
  onImport?: (url: string) => void
}
~~~

Pass this state to createResolve(data) and createLoad(data). Make deactivation explicit.

## Implementation workflow

1. Inventory the contract: Node range, package type and exports, preload order, supported extensions, CJS promises, tsconfig behavior, source-map behavior, and teardown.
2. Define ownership: normally local file URLs and explicit source extensions. Leave node:, builtins, data URLs, WASM, and unowned dependencies to Node unless a feature explicitly owns them.
3. Define the format table for mts, cts, mjs, cjs, ambiguous ts/js, and package type.
4. Prove registration and teardown with a real child process before implementing transformation.
5. Implement resolve as a conservative wrapper around Node. Preserve exports, imports, conditions, errors, queries, fragments, and parent URLs.
6. Implement load after resolve. Call nextLoad to learn Node's format, then transform only owned source and return a valid format/source pair.
7. Add source maps, diagnostics, cache controls, and capability gates.
8. Validate the built artifact through node --import, not only by calling hook factories directly.

## Resolve hook

### Resolution order

Use this default order:

1. Pass inactive hooks, unmatched namespaces, node: specifiers, and unsupported protocols directly to nextResolve.
2. Separate specifier metadata from its clean request without confusing a literal question mark in a filesystem path with URL query syntax.
3. For local source requests, cheaply probe documented extension candidates.
4. Delegate the exact request to Node so package exports, imports, conditions, self-references, symlinks, and custom loaders retain native behavior.
5. After a module-not-found or package-path-not-exported result, retry only documented source candidates. Re-throw unrelated errors unchanged.
6. For directory support, preserve package main and exports rules before trying an index candidate. Never bypass a package root exports boundary.

The tsx resolver implements this in resolveBase and resolveDirectory. It resolves local TypeScript candidates early, but lets dependencies use Node first. Its extension policy is explicit: do not turn an existing .ts into .ts.ts; preserve exact source paths; keep package exports/imports authoritative.

### Result and metadata

Never mutate a continuation result. Clone before changing url or format:

~~~js
const native = await nextResolve(specifier, context)
const resolved = { ...native }
resolved.url = mergeMetadata(resolved.url, requestMetadata)
return resolved
~~~

Merge query and fragment metadata only after the clean request has resolved. Preserve metadata from another loader and return a fresh object. Tests in tests/specs/esm-hook-resolve.ts verify that two requests do not corrupt a shared result.

### Format and conditions

Let Node decide the format when possible. Normalize Node's module-typescript and commonjs-typescript formats to the format your load hook returns. If Node provides no format for an ambiguous local file, derive it from extension and nearest package type. Do not read package metadata when Node has already supplied the answer.

Preserve the conditions array. A request with require but not import may require a CJS transform even when the same path imported from ESM requires an ESM transform.

### TypeScript paths and allowJs

Apply tsconfig path aliases only for project-owned parents. Do not reinterpret a dependency's bare specifier using the application's aliases. Resolve candidate aliases through the same extension and directory logic, then fall back to Node.

Treat allowJs as a local-project policy. It must not silently rewrite published dependency JavaScript. Use get-tsconfig-style file inclusion checks before passing compiler options to the transformer.

### Namespaces and virtual URLs

Use an opaque namespace in a query marker, or a fragment marker for data URLs, when multiple registrations share a process. Handle a request only when its namespace matches. Inherit a parent namespace for descendants. Remove internal markers from user-visible import reports and from import.meta.url.

If a CJS module needs a data response URL, encode the original path and meaningful metadata so identity, diagnostics, and cache behavior remain recoverable. Never let an internal marker become a user-facing URL.

## Load hook

### Delegate first, transform second

For owned URLs, call nextLoad first when its format or response URL is needed. For unowned URLs, return nextLoad unchanged. Preserve nullish source results, native errors, import attributes, and formats.

~~~ts
const loaded = await nextLoad(loadUrl, preparedContext)
if (!loaded.source) return loaded
const code = decodeText(loaded.source)
if (isEsmTypeScript(loaded.format, url)) {
  const result = transformToEsm(code, filePath)
  return { format: 'module', source: withInlineSourceMap(result) }
}
if (isCjsTypeScript(loaded.format, url)) {
  const result = transformToCjs(code, filePath)
  return { ...loaded, format: 'commonjs', source: withInlineSourceMap(result) }
}
return loaded
~~~

Provide a synchronous twin when using module.registerHooks. Async and sync paths should have the same ownership, format, metadata, error, and source-map semantics.

### Format rules

- ESM TypeScript transforms to ESM and returns module. Preserve top-level await and ESM URL behavior.
- CJS TypeScript transforms to CJS and returns commonjs. Preserve require, module, exports, and CJS cache expectations.
- Ordinary ambiguous JavaScript is not transformed merely because its extension is js. Transform only for a documented syntax or instrumentation need.
- JSON keeps Node's import-attribute rules. If a compatibility shim adds type=json, preserve an existing caller value. CJS require must still receive JSON in Node's expected form.
- Builtins and internal modules remain native.

### CJS named-export interop

Node versions may preparse the original CJS source instead of the source returned by an older loader. If named ESM imports from transformed CJS are a product promise:

- detect whether the parent requests named or namespace exports;
- transform TypeScript before Node's CJS lexer sees it;
- use an ESM fallback or virtual response URL only for requests that need it;
- retain the original path for import.meta.url and stack traces;
- do not convert every CJS entry to ESM for one interop case.

tsx records transformed parent source for import analysis and uses CJS-specific response URLs in src/esm/hook/utils.ts and src/esm/hook/load.ts. Treat this as an advanced compatibility layer.

### Dynamic import and import.meta

If a CJS transform rewrites dynamic import, keep the rewrite explicit and test default interop. If import.meta is rewritten, derive its URL from the original file URL, not from an evaluation-only data URL. Expose dirname and filename only when the running Node version supports them or when a documented compatibility layer owns them.

## Registration and teardown

Feature-detect capabilities centrally. tsx selects synchronous module.registerHooks only when the relevant CJS re-entry behavior is safe; otherwise it uses asynchronous module.register with a cache-busted hook entry.

Async registration should:

1. create a MessageChannel;
2. register a unique hook-entry URL with module.register;
3. pass port, namespace, and options through data and transferList;
4. use the other port for load events and deactivation acknowledgement;
5. unref optional notification ports;
6. mark the state inactive before waiting for acknowledgement.

Sync registration should retain the deregister handle, deactivate state, deregister hooks, and restore the previous process.sourceMapsEnabled value. Both paths must detach listeners and stop future transformations.

Reject initialization without expected data when that indicates a deprecated --loader protocol. Do not silently adapt an unsupported protocol.

If CJS support patches Module._resolveFilename or Module._extensions, keep it behind a separate CJS entry or explicit API. Save originals, compose with existing wrappers, restore only if your wrapper is still installed, and disable state before restoration. The guard in src/cjs/api/register.ts is the model.

## Compatibility strategy

Maintain a capability table instead of scattered version checks. Important gates include:

| Capability | Consequence |
|---|---|
| module.register | Async ESM hooks and transferred initialization data |
| module.registerHooks | Synchronous hooks and possible CJS re-entry |
| ESM load read-file support | Whether the load hook can transform CJS source directly |
| Import attributes | importAttributes versus older importAssertions context |
| Native TypeScript | Node may return TypeScript formats or strip syntax itself |
| CJS namespace behavior | Named-export and module.exports interop strategy |
| import.meta path properties | Whether dirname and filename are exposed |
| require(ESM) | CJS resolver and top-level-await behavior |

Use explicit ranges for discontinuous backports. Test Node 18.19 and 20.6 registration boundaries, sync registerHooks CJS-reload boundaries such as 22.22.3 and 24.11.1, and every version where import attributes, native TypeScript, or require(ESM) changes.

Avoid static imports of newer named Node exports on old versions. A namespace import can safely inspect optional worker-thread fields. Do not recursively register the preload in Node's internal loader thread, while preserving user worker preloads when required.

## Caching and source maps

A transform cache key must include source text, normalized path or URL, transform options, compiler version, loader-transform version, and dynamic-import transformer version. A code-only key becomes stale after option or tool changes.

A memory cache plus optional disk cache is useful for repeated processes. Disk I/O must be best-effort: tolerate corrupt entries and reader/writer races, expire entries in bounded batches, and provide a disable-cache switch. Correctness must not depend on cache success. tsx uses TSX_DISABLE_CACHE and includes tool versions in its SHA-1 key.

Enable source maps only while the registration is active and restore the previous setting on teardown. Inline the generated map, preserve the original sourcefile, and test thrown stack locations and coverage. Keep type-checking separate: a runtime transformer does not replace tsc --noEmit.

## Testing matrix

Use a child-process harness that records Node version, exitCode, stdout, stderr, and signal. Run the built package path through real node --import. Unit-test URL and format helpers, but do not treat mocked hook calls as proof of preload behavior.

### Entry and lifecycle

- package-name, relative, absolute, NODE_OPTIONS, and --import= forms;
- ts, mts, cts, js, and mjs entry files;
- package type module, commonjs, and omitted type;
- multiple imports in both orders;
- an earlier TypeScript preload and another async loader;
- repeated registration, namespace isolation, unregister, and process exit without port leaks;
- user workers versus Node internal loader workers.

### Resolution

- exact extensions, extensionless local imports, index and package main;
- exports/imports maps and conditional import/require targets;
- aliases from local parents versus the same name from dependencies;
- query, fragment, encoded URL, literal question mark, data URL, and builtin;
- missing module, missing package, package export error, and unsupported directory import;
- preservation of native error codes and messages for true misses.

### Loading and interop

- syntax that native strip-only TypeScript rejects;
- ESM top-level await and CJS top-level-await failure;
- dynamic import in transformed CJS;
- import.meta.url and supported path properties;
- JSON with and without import attributes;
- CJS default, named, namespace, and module.exports imports;
- source-map locations and external maps;
- nullish source from a composed loader;
- the same module reached through CJS and ESM paths.

Add negative controls for builtins, unowned JavaScript, foreign namespaces, and dependencies. Assert values and external process behavior, not only transformed strings. Run with cache enabled and disabled.

## Failure modes and hard stops

- Transforming before native resolution breaks exports, conditions, and custom loaders. Use Node first or a narrow local fast path.
- Returning paths instead of file URLs breaks identity and cross-platform behavior. Stay in URL space until a filesystem API requires a path.
- Dropping query or fragment metadata changes module identity. Merge it without mutating continuation results.
- One global state object causes registration and worker interference. Allocate state per registration entry.
- Transforming every CJS or JS file changes native semantics. Transform only owned cases.
- Applying aliases inside dependencies overrides package resolution. Restrict aliases to eligible project parents.
- Checking only that an API exists misses backports and CJS reload constraints. Use capability ranges and behavior tests.
- Leaving MessagePorts, watchers, or listeners referenced hangs short-lived processes. Unref optional observers and dispose them.
- Treating cache hits as proof hides stale transforms. Include all inputs and test cache failures.
- Claiming runtime transformation provides type safety is incorrect. Run a separate type-check.
- Do not invent extension fallback, override package exports, recursively transform the preload, run sync hooks before their CJS safety boundary, swallow non-miss errors, or leave registration active after the owner exits.

## Validation and completion report

Run the project's equivalent of build, lint, type-check, and test. Then execute direct smoke commands against the built artifact, including plain Node baseline, node --import preload entry, a TypeScript dynamic import, a builtin, JSON attributes, and a source-map failure. Record exact commands and versions actually run; report unverified Node boundaries or environment blockers.

The completion report should state:

- target skill and source paths inspected;
- supported Node range and capability gates;
- hook ownership, resolution fallback, transformation formats, and lifecycle;
- CJS and source-map promises;
- child-process and version matrix covered;
- commands and outcomes;
- remaining unverified cases.

## Source map

- Bootstrap and per-registration state: src/esm/index.ts, src/esm/hook/initialize.ts
- Registration, feature selection, ports, and unregister: src/esm/api/register.ts
- Async and sync resolution: src/esm/hook/resolve.ts
- Async and sync loading: src/esm/hook/load.ts
- Namespaces, URL markers, and CJS import analysis: src/esm/hook/utils.ts
- Capability ranges: src/utils/node-features.ts
- Transform options and cache: src/utils/transform/index.ts, src/utils/transform/cache.ts
- Inline source maps: src/source-map.ts
- CJS bridge: src/cjs/api/register.ts, src/cjs/api/module-resolve-filename/index.ts
- CLI usage: docs/dev-api/node-cli.md
- Hook contracts: tests/specs/esm-hook-resolve.ts
- Composition and Node regressions: tests/specs/version-sensitive.ts
