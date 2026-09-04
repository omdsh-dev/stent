---
name: ts-class-first-state-management
description: Use when designing, implementing, reviewing, or refactoring TypeScript that owns mutable state or lifecycle—stores, services, managers, controllers, repositories, domain objects, caches, subscriptions, or async workflows—to keep state and behavior in cohesive classes instead of scattered interfaces and free functions. Do not use for pure data shapes, DTOs, schemas, discriminated unions, or genuinely stateless transformations.
---

# Class-First TypeScript State Management

Use this skill to keep mutable state, the operations that change it, its invariants, and its lifetime under one explicit owner. TypeScript interfaces describe structure; they do not provide runtime ownership, encapsulation, transition control, disposal, or synchronization. A class is the default for a stateful runtime object. A type or interface remains the default for a data-only shape or a deliberately structural boundary.

This is guidance, not a ban on interfaces or a demand to turn every value into a class. The goal is to prevent a stateful abstraction from being split into a mutable interface, unrelated functions, module globals, and ad-hoc callbacks.

## Applicability gate

Apply this skill when a change introduces or modifies any of the following:

- mutable state with more than one operation or writer;
- invariants that must hold across operations;
- identity, caching, deduplication, ownership, or resource lifetime;
- subscriptions, events, observers, or derived state;
- asynchronous work that can complete, cancel, supersede, or fail;
- a store, service, manager, controller, repository, session, domain aggregate, or runtime registry;
- a createX() object whose state and behavior are meant to live beyond one expression.

Do not apply the class-first rule to force classes onto:

- JSON, wire, persistence, configuration, form, or API data shapes;
- discriminated unions that describe states or events;
- readonly snapshots and value objects with no identity or lifecycle;
- function types, pure transformations, validators, or stateless adapters;
- framework-mandated structural contracts, third-party types, or dependency ports with multiple current implementations.

When a framework requires a plain-object reducer or serializable state shape, keep that shape at the framework boundary and put ownership, orchestration, and lifecycle in a class or service around it where the framework permits. Do not replace a framework contract with a private class merely to satisfy this skill.

## Required design decisions

Before editing, identify these facts. If they are not inferable from the repository or request, ask one concise batch of questions rather than inventing them:

- **Owner:** which one concrete object owns the authoritative mutable state?
- **Lifetime:** when is that object created, reused, disposed, or replaced?
- **Commands:** which methods are allowed to mutate it, and what preconditions do they enforce?
- **Queries:** which readonly views can callers observe without obtaining mutable internals?
- **Invariants:** what must be true after construction and after every successful operation?
- **Effects:** which notifications, persistence writes, network calls, or external effects happen, and at what commit point?
- **Concurrency:** which operation settles readiness, cancellation, supersession, disposal, and rollback?
- **Boundary:** which inputs cross a JSON, file, process, worker, wire, or framework boundary and therefore need parsing or validation?

Record the class boundary before writing helpers. A useful decision table is:

| Concern | Preferred decision |
| --- | --- |
| Stateful runtime owner | concrete class with private state |
| Public read model | readonly snapshot or query result |
| Mutation | named method/command on the owner |
| External dependency | constructor-injected port or concrete provider |
| External data | type/interface plus runtime parsing at the boundary |
| Notification | owner subscription with an explicit disposer |
| Async operation | owner-controlled transaction/lifecycle controller |
| Pure calculation | private function or standalone function |

## Core rules

1. **One source of truth.** Give each mutable fact one owner. Do not mirror the same state in a module variable, a returned object, a cache, and a UI adapter without an explicit synchronization and invalidation design.
2. **Class-first for state.** If an object has identity, mutable fields, invariants, lifecycle, subscriptions, or asynchronous ownership, start with a concrete class. Add an interface only when a current consumer needs a structural port, a framework requires it, or independent implementations genuinely exist.
3. **Keep state private.** Use private or ECMAScript # fields. Do not expose public mutable fields, mutable arrays/maps/sets, or a state object whose properties callers can write around the owner.
4. **Make transitions explicit.** Prefer load(), addItem(), reserve(), commit(), cancel(), or another domain operation over generic setState(), arbitrary property setters, or an update(patch) escape hatch. Each operation validates its preconditions and preserves the invariant.
5. **Publish only committed state.** Apply and validate the complete mutation first. Then derive a snapshot and notify observers. Do not expose half-written state, emit an event before a failing write, or update a derived cache from an operation that later rolls back.
6. **Expose views, not internals.** Return readonly snapshots, value objects, iterators, or specific query results. Copy mutable collections at the public boundary or expose an intentionally immutable representation. Never let a caller retain a mutable reference that bypasses the class.
7. **Own the lifetime.** If the class subscribes, starts timers, opens resources, creates workers, or launches requests, give it an explicit dispose()/close() contract or another clearly named owner. Disposal must release owned resources, prevent future commits, and define what subsequent calls do.
8. **Make async ownership singular.** One operation controller or transaction owns cancellation, supersession, rollback, and settlement. A late result must not commit after disposal or after a newer operation has superseded it. Do not scatter request tokens and isLoading flags across unrelated modules.
9. **Inject real dependencies.** Pass clocks, persistence, transport, schedulers, and ports through the constructor or a factory that creates the class. Do not hide stateful dependencies in module globals or import-time singletons unless the application explicitly defines that singleton lifetime.
10. **Keep interfaces at seams.** Use an interface or type for a dependency port when the class consumes an external capability, for a framework/third-party contract, or for independently implemented providers. Do not create IFoo/FooState solely to type one concrete class or to turn a mutable object into a bag of optional methods.
11. **Use types for alternatives.** Model lifecycle modes and events as discriminated unions with required fields, not one interface full of optional properties. Let the class enforce legal transitions instead of making every caller handle impossible combinations.
12. **Prefer composition.** Share behavior through private helpers, value objects, or composed collaborators. Use inheritance or an abstract class only when the subtype relationship, lifecycle, and invariant ownership are real and current; never add a base class to avoid choosing an owner.
13. **Do not preserve a broken split.** When refactoring a pre-stable or internal API, replace the interface-plus-functions design directly and update current consumers. Do not leave a deprecated mutable interface, forwarding wrappers, or two competing state owners unless compatibility is an explicit supported requirement.
14. **Keep pure code pure.** Calculations that do not read or mutate owned state should remain standalone functions or private methods. A class should own state and policy, not become a dumping ground for unrelated helpers.

## Recognize the interface abuse

Treat these patterns as prompts to inspect ownership, not as mechanical lint errors:

- interface SomethingState plus exported getSomething, setSomething, resetSomething, and subscribeSomething functions;
- a module-level let currentState, const listeners, or const cache shared by otherwise unrelated functions;
- a createSomething() function returning an object with mutable fields, setters, callbacks, and hidden cleanup;
- an exported interface with all fields mutable and a separate collection of functions that are expected to preserve its invariants;
- one implementation of IFoo with no current alternate consumer or provider;
- a generic setState(partial) API that permits callers to construct invalid combinations;
- several isLoading, error, data, and requestId variables whose legal combinations are not represented by a discriminant;
- a class that exists only as a typed wrapper around a pure function, or an interface added only to make that wrapper appear extensible.

For each finding, name the authoritative owner and decide whether the correct repair is a concrete class, a value/type, a structural port, or removal of the abstraction. Do not create a class façade while leaving the old state owner active.

## Implementation workflow

### 1. Inventory the state graph

Read the nearest repository instructions and the target module before editing. Trace every state field, writer, reader, event, timer, request, cache, disposer, and consumer. Search both names and behavior: setters, resets, invalidation, loading flags, subscription calls, and direct field writes. Classify each match as source owner, consumer, test, documentation, generated output, or an intentional boundary.

Capture unrelated worktree changes. Never reset or overwrite them.

### 2. Design the owner and public surface

Choose the smallest concrete class that can enforce the rules. Put constructor validation, private fields, named commands, readonly queries, and lifecycle methods on that class. Decide whether a snapshot is shallow or deep, whether subscriptions are synchronous or scheduled, how listener errors are handled, and whether disposal is idempotent. These are observable semantics; do not leave them to incidental implementation behavior.

For a state machine, use a closed discriminated union for the state view and keep transitions private to the class:

~~~ts
type LoadView<T> =
  | { status: 'idle' }
  | { status: 'loading'; requestId: number }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: Error }

class ResourceController<T> {
  #view: LoadView<T> = { status: 'idle' }
  #nextRequestId = 0
  #disposed = false

  get view(): LoadView<T> {
    return this.#view
  }

  // load(), cancel(), and dispose() own all legal transitions.
}
~~~

Do not export #view, a mutable state interface, or a generic setter that lets callers manufacture an invalid LoadView. If the view contains mutable data, return a defensive snapshot or an immutable value rather than the internal reference.

### 3. Implement behavior around commit points

Use this order unless the domain requires a documented variant:

1. assert the owner is active;
2. validate arguments and current-state preconditions;
3. calculate the complete next state without publishing it;
4. perform required effects with a defined rollback or failure policy;
5. commit the authoritative state atomically;
6. derive the public snapshot;
7. notify observers and schedule downstream work according to the documented policy.

For async work, capture an operation identity when starting, check that identity and lifecycle again before committing, and settle the operation exactly once. A request's completion is not permission to mutate merely because it succeeded externally.

### 4. Integrate consumers directly

Update consumers to call the class's domain methods and readonly queries. Keep UI/framework adapters thin: they subscribe, read a snapshot, and translate user actions into commands. They must not reach into private state or reproduce the class's transition logic.

Use an interface/type only where the consumer truly needs a structural seam. Name it after the capability (Clock, Store, Transport) rather than adding an I prefix. Keep the concrete class as the primary implementation and avoid widening private helpers to a broad context just to hide dependencies.

### 5. Verify the ownership model

Tests should instantiate the real class and exercise its public behavior. Cover:

- constructor rejection and invariant preservation;
- every legal command and illegal transition;
- independent instances not sharing state accidentally;
- snapshots that cannot mutate the owner through retained references;
- notification timing, one notification per committed transition, and unsubscribe behavior;
- disposal, resource cleanup, post-disposal calls, and idempotence if promised;
- cancellation, superseded requests, late results, failure, and rollback for async work;
- boundary parsing for untrusted or durable input;
- integration consumers using the class rather than duplicating its state.

Do not test private fields merely because they exist. Add a type-level check when readonly exposure or the absence of an old mutable API is part of the contract. Use a real integration/lifecycle path when the class owns a registry, process, worker, persistence, or framework subscription.

## Exceptions that must be explicit

A plain object, interface, or functional store can be correct when its shape is imposed by a framework, serialization protocol, generated client, reducer architecture, or a genuinely stateless/data-only contract. Keep the exception at that boundary and document who owns mutation, invariants, lifetime, and synchronization. Do not use “TypeScript is structural” or “it is easier to mock” as the only reason to split a stateful owner.

A closure is acceptable for short-lived private state with one owner and no public identity, lifecycle, or independent observation. It is not a substitute for a public state manager with multiple operations, consumers, or a disposal contract.

An interface is appropriate for a current dependency port even if there is only one provider today when the port is an actual process, worker, network, persistence, or framework seam and the implementation must remain replaceable there. The evidence is the seam and its consumer, not hypothetical future implementations.

## Review checklist

Before reporting completion, confirm:

- [ ] Every mutable fact has one named owner.
- [ ] Stateful runtime behavior lives in a concrete class or an explicitly justified framework boundary.
- [ ] Constructor and command methods preserve invariants.
- [ ] No public mutable field, collection, or state reference bypasses the owner.
- [ ] Queries return readonly/defensive views; snapshots do not become a second source of truth.
- [ ] Notifications occur after commit and have a documented error/timing policy.
- [ ] Async work cannot commit after cancellation, supersession, or disposal.
- [ ] Owned listeners, timers, requests, workers, and resources have a tested teardown path.
- [ ] Interfaces/types have a current structural purpose; no speculative I* or *State wrapper remains.
- [ ] Framework and external data shapes stay at their required boundaries and are validated where needed.
- [ ] Consumers use domain methods rather than reproducing transitions.
- [ ] Focused tests and the repository's relevant type, lint, format, and build checks ran successfully.

Report the chosen owner, the class public surface, justified structural interfaces, lifecycle/concurrency semantics, files changed, exact checks run, and any explicit exception. Never claim the state-management refactor is complete while two mutable owners or an unowned cleanup path remain.
