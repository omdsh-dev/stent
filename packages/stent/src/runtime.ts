/**
 * Process-local Stent runtime: owns patch lifecycle state and dispatches
 * transformed calls published through the shared bridge.
 *
 * The runtime is intentionally Cordis-free. Transformed target code runs before
 * any Cordis context exists and must never receive a `Context`; dispatch
 * happens through the bridge's in-memory listener set, keyed by patch id. The
 * Cordis service attaches and detaches handlers here.
 *
 * The subscription is installed on first enable and intentionally never removed
 * while the process lives: transformed modules are already evaluated and keep
 * publishing to the bridge, and removing the subscription would strand them
 * with a dead slot across fiber reloads. Disabling a patch removes its handler,
 * so transformed code then delegates to the original body through the
 * no-listener path in the bridge.
 *
 * @module @oh-my-dsh/stent/runtime
 */

import { subscribeBridge } from './bridge.ts'
import {
  comparePatchOrder,
  compareStrings,
  dispatch,
  registerChange,
  targetKey,
} from './runtime-dispatch.ts'
import type {
  PatchId,
  StentBinding,
  StentHandler,
  StentPatchChange,
  StentPatchChangeListener,
  StentPatchInfo,
} from './types.ts'

/** Runtime state of one registered patch. */
interface PatchEntry {
  /** Immutable patch metadata (no handler functions). */
  info: StentPatchInfo
  /** Currently installed handler, when the patch is enabled. */
  handler: StentHandler | undefined
  /**
   * Identity of the registration owner: a patch id is exclusive to one owner,
   * and only the same owner may re-register it (an HMR generation replaces its
   * plugin's own patch; a different plugin's same-id claim is rejected). The
   * Cordis service resolves the owner from the registering fiber (loader entry,
   * plugin callback, or the fiber itself).
   */
  owner: unknown
  /**
   * The fiber whose disposal currently owns the entry's removal. A same-owner
   * re-registration transfers ownership, so the previous fiber's disposer
   * becomes a no-op and cannot unregister the newer registration.
   */
  fiber: unknown
}

/** Registry of enabled Stent patches with the shared bridge subscription. */
class StentRuntime {
  private readonly entries = new Map<PatchId, PatchEntry>()
  /** Load-time bindings per patch, recorded by the transformation hooks. */
  private readonly bindings = new Map<PatchId, StentBinding[]>()
  /** Node loader subscribers that rebuild their current matcher snapshot. */
  private readonly patchListeners = new Set<StentPatchChangeListener>()
  private subscribed = false

  /**
   * Subscribe to patch metadata changes.
   *
   * The Node loader uses this to rebuild its instrumentation matcher when a
   * plugin registers or removes a patch. Handler enable/disable changes do not
   * emit events because transformed code dispatches through the runtime.
   */
  public onPatchChange(listener: StentPatchChangeListener): () => void {
    this.patchListeners.add(listener)
    return () => {
      this.patchListeners.delete(listener)
    }
  }

  /**
   * Register patch metadata; the patch stays disabled until
   * {@link StentRuntime.enable} installs its handler.
   *
   * @param info - Validated patch metadata.
   * @param owner - Identity of the registration owner; defaults to the patch id
   *   for raw-runtime callers. Re-registering an id owned by a different owner
   *   fails loud — a patch id is exclusive to one plugin — while the same owner
   *   may re-register (an HMR generation takes its plugin's patch back) and
   *   transfer {@link PatchEntry.fiber fiber} ownership.
   * @param fiber - The fiber whose disposal owns the entry's removal; the
   *   Cordis service passes the registering fiber so its disposer can check
   *   {@link StentRuntime.isOwnedBy}.
   * @returns Whether the id was newly registered (false re-registers metadata).
   * @throws When another `replace` patch already claims the same target, or
   *   when the id is already registered by a different owner.
   */
  public register(
    info: StentPatchInfo,
    owner: unknown = info.id,
    fiber?: unknown,
  ): boolean {
    const previous = this.entries.get(info.id)
    if (previous && previous.owner !== owner) {
      throw new Error(
        `stent: patch ${JSON.stringify(info.id)} is already registered by another owner; `
          + 'a patch id is exclusive to one plugin (HMR re-registration reuses the same owner)',
      )
    }
    if (info.operation === 'replace') {
      this.claimReplaceTarget(info, previous)
    }
    this.entries.set(info.id, {
      info,
      handler: previous?.handler,
      owner,
      fiber,
    })
    this.notifyPatchChange(registerChange(info, previous?.info))
    return previous === undefined
  }

  /**
   * Install a patch's handler and ensure the bridge subscription exists.
   *
   * @param id - The patch id.
   * @param handler - The trusted runtime handler.
   */
  public enable(id: PatchId, handler: StentHandler): void {
    const entry = this.entries.get(id)
    if (!entry) {
      throw new Error(
        `stent: cannot enable unregistered patch ${JSON.stringify(id)}`,
      )
    }
    if (typeof handler !== 'function') {
      /* Fail loud at enable (the earliest resolvable point) instead of
         crashing inside a transformed call when dispatch tries to run it. */
      throw new TypeError(
        `stent: handler for patch ${JSON.stringify(id)} must be a function`,
      )
    }
    entry.handler = handler
    this.subscribe()
  }

  /**
   * Remove a patch's handler; the bridge subscription (if any) stays alive.
   *
   * @param id - The patch id.
   */
  public disable(id: PatchId): void {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }
    entry.handler = undefined
  }

  /**
   * Remove a patch entirely. The bridge subscription stays alive so any
   * transformed module already evaluated keeps delegating to the original body
   * rather than publishing into a dead slot.
   *
   * @param id - The patch id.
   */
  public remove(id: PatchId): void {
    const previous = this.entries.get(id)
    if (previous === undefined) {
      return
    }
    this.entries.delete(id)
    this.notifyPatchChange({ type: 'remove', id, previous: previous.info })
  }

  /** Whether the given fiber still owns the entry. */
  public isOwnedBy(id: PatchId, fiber: unknown): boolean {
    const entry = this.entries.get(id)
    return entry !== undefined && entry.fiber === fiber
  }

  /** Whether a patch is currently registered and enabled. */
  public isEnabled(id: PatchId): boolean {
    return this.entries.get(id)?.handler !== undefined
  }

  /** Record the load-time bindings for a patch. */
  public recordBindings(id: PatchId, records: readonly StentBinding[]): void {
    const existing = this.bindings.get(id)
    if (existing) {
      existing.push(...records)
    } else {
      this.bindings.set(id, [...records])
    }
  }

  /** Return the recorded load-time bindings for a patch. */
  public bindingsOf(id: PatchId): readonly StentBinding[] {
    return this.bindings.get(id) ?? []
  }

  /**
   * Snapshot of every recorded binding, flattened in patch-id order.
   *
   * @returns All recorded bindings across patches.
   */
  public allBindings(): readonly StentBinding[] {
    return [...this.bindings.keys()]
      .toSorted(compareStrings)
      .flatMap((id) => this.bindingsOf(id))
  }

  /**
   * Ordered diagnostic snapshot of all registered patches.
   *
   * @returns The patch infos sorted by priority then id, each carrying its
   *   recorded load-time bindings.
   */
  public list(): StentPatchInfo[] {
    const infos: StentPatchInfo[] = []
    for (const entry of this.entries.values()) {
      infos.push({
        ...entry.info,
        enabled: entry.handler !== undefined,
        bindings: this.bindingsOf(entry.info.id),
      })
    }
    return infos.toSorted(comparePatchOrder)
  }

  /** Notify all loader subscribers after the registry has changed. */
  private notifyPatchChange(change: StentPatchChange): void {
    for (const listener of this.patchListeners) {
      listener(change)
    }
  }

  /**
   * Reject another `replace` patch claiming the same target.
   *
   * A re-registration of this id that already holds replace on the same target
   * is the entry itself; every other replace registration must pass the
   * exclusive-target scan (a first registration as `before` must not be able to
   * re-register into an already-claimed replace target by bypassing the
   * check).
   */
  private claimReplaceTarget(
    info: StentPatchInfo,
    previous: PatchEntry | undefined,
  ): void {
    const key = targetKey(info.target)
    const selfClaim =
      previous?.info.operation === 'replace'
      && targetKey(previous.info.target) === key
    if (selfClaim) {
      return
    }
    for (const existing of this.entries.values()) {
      if (
        existing.info.operation === 'replace'
        && targetKey(existing.info.target) === key
      ) {
        throw new Error(
          `stent: replace patch ${JSON.stringify(info.id)} conflicts with existing `
            + `replace patch ${JSON.stringify(existing.info.id)} on the same target`,
        )
      }
    }
  }

  private subscribe(): void {
    if (this.subscribed) {
      return
    }
    this.subscribed = true
    subscribeBridge((call) => {
      const entry = this.entries.get(call.id)
      if (!entry) {
        return call.traced()
      }
      return dispatch(entry, call)
    })
  }
}

/** Singleton runtime shared by the Cordis service and the transform hooks. */
const runtime = new StentRuntime()

export { runtime }
export { validatePatchId, validatePatchStatic } from './transform/validation.ts'
export type { StentPatchChange, StentPatchChangeListener } from './types.ts'
