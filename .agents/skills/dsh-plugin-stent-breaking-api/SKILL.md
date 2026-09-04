---
name: dsh-plugin-stent-breaking-api
description: Use when intentionally making a breaking API change in the Stent repository for a pre-1.0 non-stable release or for a release that crosses a major version. Replace the old API across current consumers instead of adding compatibility shims; do not use for stable same-major releases.
---

# Make a Deliberate Stent API Break

This skill is guidance, not an autonomous migration script. Use it when the final API should be corrected now rather than protected by transitional aliases, deprecated wrappers, or speculative compatibility code. Preserve safety, lifecycle, and data-integrity guarantees while allowing the public API itself to change.

## Applicability gate

Apply the skill only when at least one condition is proven for every affected package:

| Release situation | Apply? | Required stance |
| --- | --- | --- |
| The current line is explicitly pre-1.0 and non-stable, normally `0.x` in this repository | Yes | Replace the API directly and update all current consumers. |
| The intended release has a different numeric major from the current release | Yes | Treat the change as a major-version migration with no old-API shim. |
| A stable release keeps the same major and changes only minor or patch | No | Preserve the supported API and use the normal compatibility workflow. |
| The version policy, affected packages, or target release is unclear | Stop | Establish the release gate before editing. |

A `0.x` version is not a reason to preserve an API merely because it has no prerelease suffix. Confirm the repository's release policy; this repository currently treats its `0.1` line as non-stable. For a package with its own version, evaluate that package rather than borrowing the root version. If a release crosses a major version, the major-version condition is sufficient even when the current line is stable.

Do not use this skill to justify data loss, removal of a security invariant, bypassing approval, or silently changing an external wire protocol. Those decisions need their own explicit design and authority. A one-time data migration or an intentional rejection of obsolete data may be appropriate; permanent dual-format support is not the default.

## Read before editing

Run from the Stent repository root and read the nearest instructions first:

- `AGENTS.md`
- `README.md` and `README.zh.md`
- the affected package README files;
- the affected package manifests, `exports`, TypeScript entry points, and build configuration;
- the source, tests, fixtures, and focused docs that own the changed API;
- `packages/stent/docs/transform-api.md` and `packages/stent/docs/transform-architecture.md` when transformation or loader behavior is involved.

The current Stent workspace has three implementation packages. Trace the actual owner before changing an export:

- `@oh-my-dsh/stent` owns the platform-free runtime and service;
- `@oh-my-dsh/stent/loader` owns Node hook installation and cache re-transformation;
- `@oh-my-dsh/stent/browser` owns browser transforms and runtime serving;
- `@oh-my-dsh/stent/client` owns the browser Cordis entry;
- `@oh-my-dsh/stent-api` owns the deliberate cooperative compatibility facade;
- `@oh-my-dsh/stent-dsh` owns DSH facades, profile bootstrap, and catalog integration.

Do not inspect or edit `node_modules/` or generated `lib/` as source owners. Do not read a sibling checkout as an implicit contract. Keep source, documentation, fixtures, and skill references below this repository root.

## Required inputs

Establish these facts before implementation:

- the current and intended version for every affected package;
- the evidence that the applicability gate is satisfied;
- the old API and the intended final API, including removed names, types, exports, errors, defaults, and lifecycle behavior;
- every in-repository consumer, public entry point, package export, patch target, fixture, and documentation owner;
- whether the change reaches persisted data, a worker/process boundary, a browser bundle, a wire protocol, or an external package;
- the version-range and distribution changes needed by the intended release;
- the focused checks and the cross-package checks that can prove the migration.

If the gate or the final API is not specified, ask one concise batch of questions and stop. Do not infer permission to break a stable same-major consumer from a vague request to “clean up” an API.

## Core rules

1. **Design the destination first.** Write a small old-to-new table before editing. Choose the API that should remain after the migration, not an intermediate API that makes the next change easier.
2. **Update current consumers together.** Change the owner, all in-repository callers, package exports, fixtures, tests, and docs in one coherent change. Do not leave the tree compiling only because an old alias remains.
3. **Delete historical compatibility code.** Do not add deprecated exports, forwarding functions, overloaded old signatures, renamed-symbol aliases, permissive fallbacks, version sniffing, dual serialization, or feature flags whose only purpose is to keep the old API alive. Remove obsolete code rather than labeling it temporary.
4. **Do not support hypothetical consumers.** External users receive a migration note and a new release; they do not require an old API branch in the new implementation. Keep an adapter only when it is a current, named product capability with an owner and consumer.
5. **Keep safety separate from compatibility.** Preserve validation at parser, process, worker, browser, persistence, and wire boundaries; preserve approval, authorization, cancellation, disposal, and required-binding checks. Changing names or types does not permit weakening those guarantees.
6. **Keep the public boundary intentional.** Do not expose an implementation type, transform intermediate, loader state, or host detail merely to make a migration compile. If a public export is no longer part of the final design, remove it and update its consumers.
7. **Make version ranges honest.** Update package versions, peer ranges, target package `versionRange` selectors, lockfiles, and bundle metadata when the supported API changes. Do not claim one range supports two incompatible contracts.

The `stent-api` package name does not make every compatibility layer valid. Its cooperative facade is a current package contract and may remain when its consumers need it; historical aliases added solely for an older Stent API do not belong there.

## Workflow

### 1. Inventory the blast radius

Record the release gate and inspect the complete API path:

- public TypeScript types and runtime values;
- named exports, default exports, subpath exports, and package `files` entries;
- Cordis services, injections, events, registration and disposer paths;
- Node, browser, DSH, and standalone entry points;
- Stent patch descriptors, target selectors, function queries, handlers, priorities, and required bindings;
- package manifests, peer/development dependencies, profile rows, and bundle composition;
- unit tests, real loader/browser/DSH tests, process fixtures, snapshots, and bilingual docs.

Search for both the old symbol and its behavioral vocabulary. A search hit in a migration note is not proof that a runtime compatibility path is required; inspect each hit and classify it as owner, consumer, documentation, test, generated output, or deliberate historical reference.

Capture unrelated worktree changes before editing. Never reset, clean, or overwrite them.

### 2. Specify the final API

Use a decision table such as:

| Concern | Before | After | Action |
| --- | --- | --- | --- |
| Export or service | old name/entry | final name/entry | rename or remove |
| Types and parameters | old type/signature | final type/signature | update declarations and callers |
| Failure behavior | old error/default | final behavior | update owner and assertions |
| Lifecycle | old registration/cleanup | final ownership | prove disposal and quiescence |
| Target compatibility | old package/range/query | final target | update selector and fixture |
| Stored or wire data | old format | final format | migrate once or reject clearly |

Resolve naming, ownership, sync/async behavior, error codes, defaults, and disposal before implementation. If an API has one internal consumer, prefer a private capability or closure over adding a new public method. If several current consumers need different behavior, split the public capability deliberately instead of hiding branches behind a compatibility option.

### 3. Implement the direct replacement

Change the source owner and then every current consumer to the final API. Remove the old declaration and export; do not re-export it under its former name. Update both runtime and type surfaces, including package `exports` and declaration generation.

For a Stent transformation change:

- update the target package identity and `versionRange` deliberately;
- update file selectors, function queries, operation types, handler signatures, and required-binding behavior together;
- update Node and browser transform paths when both faces consume the changed type;
- preserve the rule that executable handlers live in the process and are not serialized;
- preserve the runtime registry and fiber-owned disposal model.

For a DSH composition change, keep profile YAML as activation metadata. Do not restore patch descriptors under `config.stent.patches` as a shortcut. Register patch metadata and handlers through the current runtime API, and update the relevant host, browser, bootstrap, and catalog consumers.

Do not hand-edit `lib/`; rebuild it from source. Do not add a compatibility package or a second implementation unless the final design explicitly names it as a current package with independent ownership.

### 4. Update documentation and migration guidance

Update the owning English and Chinese README pages when a public behavior or package contract changes. Update focused transform, loader, API, or bootstrap docs at their one canonical home. Keep examples executable against the final API.

For external consumers, document:

- the removed or renamed entry;
- the replacement and its changed semantics;
- required package/version or configuration changes;
- data or wire-format action, if any;
- the first release containing the break.

A migration guide explains how to move forward; it is not a reason to retain an old runtime branch. Do not add a changelog or historical section when the repository has no established owner for it; use the existing release-note convention or report the missing owner.

### 5. Rework evidence around the final contract

Update tests to call the final API and assert observable behavior, failures, lifecycle, and disposal. Add or retain a negative check when it proves that an obsolete public entry is no longer exported or accepted, but do not preserve an old fixture merely to exercise removed behavior.

Use the real entry path where the change crosses it:

- Loader and fresh-process tests for Node hook or cache behavior;
- browser bundle/runtime tests for browser exports and transforms;
- DSH Loader/profile tests for composition, facades, and bootstrap;
- package-level type-aware tests for public types and exports;
- focused unit tests for pure transformation or validation rules.

Test target-version misses and required-binding failures when selectors or ranges change. Test teardown after a plugin or registry owner is disposed. Keep external service mocks at the actual boundary and do not replace the Stent behavior under test with a hand-built fake.

### 6. Align release metadata

For each affected package, update its version according to the repository's release policy. Under ordinary SemVer, a breaking `0.x` change normally advances the minor version, while a cross-major change advances the major version; do not invent a different policy silently. Update peer ranges, workspace metadata, lockfiles, bundle rows, and target selectors together.

A version bump is not permission to publish, tag, push, rewrite history, or change a remote. Perform only the release actions explicitly requested by the user.

### 7. Verify the removal of compatibility debt

Before reporting completion:

- search source, tests, docs, manifests, and fixtures for the old names and old behavior;
- inspect every remaining match, including `@deprecated`, aliases, fallback branches, dual-format readers/writers, and old version selectors;
- confirm no public export, package `files` entry, profile row, or generated declaration still exposes the old contract;
- confirm the final API is used consistently by all current consumers;
- confirm unrelated worktree changes remain untouched.

Do not fail the search mechanically when a migration document must mention the old name. Explain deliberate historical references in the completion report.

## Stent-specific invariants to preserve

A breaking API change may alter names and types, but it must not silently remove these current guarantees:

- patch handlers are trusted process-local code, never YAML or model data;
- registrations and registry contributions are owned by a Cordis fiber and dispose cleanly;
- required patches fail loudly when no target binding exists;
- Node hook installation happens before target imports, with the supported fallback behavior documented;
- browser and Node implementation details remain behind their intended subpath boundaries;
- DSH activation capability is distinct from low-level hook installation;
- `stent-api` remains a deliberate cooperative facade rather than a dumping ground for old aliases.

If one of these guarantees must change, stop this workflow and record a separate design decision with its owner, security/lifecycle impact, and tests.

## Checks and completion report

Run only the checks relevant to the changed surfaces, but at minimum run the repository's configured formatting, lint, test, and build commands for every affected package. For a cross-package change, run the root orchestration equivalents when they exist. A typical Stent evidence set is:

~~~sh
pnpm run fmt:check
pnpm run lint
pnpm test
pnpm run build
git diff --check
~~~

Use the exact repository commands and report failures rather than replacing them with a weaker check. Run package-specific `fmt:check`, `lint`, `test`, and `build` commands when only one implementation package changed; use the root `pack:*` orchestration when the change spans packages. Run a packed-consumer or release readiness check when package exports or published files changed.

Report:

- the proven release gate and affected package versions;
- the old-to-final API decision and removed public entries;
- current consumers, target selectors, and docs updated;
- any one-time migration or intentional obsolete-data rejection;
- compatibility code deliberately not added;
- exact commands run and their results;
- remaining unverified environment-dependent checks;
- release actions not performed.

Do not describe the work as complete while an old runtime alias, stale export, unupdated consumer, or required test remains unresolved.
