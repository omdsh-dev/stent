/**
 * Process-local Stent runtime: owns patch lifecycle state and dispatches
 * transformed calls published through the shared bridge.
 *
 * The runtime is intentionally Cordis-free. Transformed target code runs
 * before any Cordis context exists and must never receive a `Context`;
 * dispatch happens through the bridge's in-memory listener set, keyed by
 * patch id. The Cordis service attaches and detaches handlers here.
 *
 * The subscription is installed on first enable and intentionally never
 * removed while the process lives: transformed modules are already evaluated
 * and keep publishing to the bridge, and removing the subscription would
 * strand them with a dead slot across fiber reloads. Disabling a patch
 * removes its handler, so transformed code then delegates to the original
 * body through the no-listener path in the bridge.
 * @module @oh-my-dsh/stent/runtime
 */

import { subscribeBridge, type StentBridgeCall } from './bridge.ts'
import type {
  StentBinding,
  StentCall,
  StentHandler,
  StentOperation,
  StentPatchInfo,
  StentTarget,
  PatchId,
} from './types.ts'

/** Runtime state of one registered patch. */
interface PatchEntry {
  /** Immutable patch metadata (no handler functions). */
  info: StentPatchInfo
  /** Currently installed handler, when the patch is enabled. */
  handler: StentHandler | undefined
  /**
   * Identity of the registration owner: a patch id is exclusive to one
   * owner, and only the same owner may re-register it (an HMR generation
   * replaces its plugin's own patch; a different plugin's same-id claim is
   * rejected). The Cordis service resolves the owner from the registering
   * fiber (loader entry, plugin callback, or the fiber itself).
   */
  owner: unknown
  /**
   * The fiber whose disposal currently owns the entry's removal. A same-owner
   * re-registration transfers ownership, so the previous fiber's disposer
   * becomes a no-op and cannot unregister the newer registration.
   */
  fiber: unknown
}

/** A patch-registry change observed by the Node loader. */
export interface StentPatchChange {
  type: 'register' | 'remove'
  id: PatchId
  previous?: StentPatchInfo
  current?: StentPatchInfo
}

/** Listener notified after patch metadata changes. */
export type StentPatchChangeListener = (change: StentPatchChange) => void

/**
 * Validate a patch id for use in diagnostics and bridge dispatch.
 * @param id - the patch id to validate.
 * @throws when the id is empty, too long, or contains unsafe characters.
 */
export function validatePatchId(id: PatchId): void {
  if (!/^[A-Za-z0-9._:/+-]{1,120}$/.test(id)) {
    throw new Error(`stent: patch id ${JSON.stringify(id)} must be 1-120 chars of [A-Za-z0-9._:/+-]`)
  }
}

/**
 * Validate the static fields of a patch descriptor: the target's module,
 * version range, and file shape, plus the operation kind. Both the service
 * registration path and the loader instrumentation path enforce the same
 * checks, so a malformed descriptor fails loud no matter which plane it
 * crossed.
 * @param patch - the descriptor's static part.
 * @throws when a target field or the operation is malformed.
 */
export function validatePatchStatic(patch: {
  target: StentTarget
  operation: StentOperation
  required?: boolean
}): void {
  const target = patch.target
  if (typeof target.module !== 'string' || target.module.length === 0) {
    throw new Error('stent: patch target.module must be a non-empty string')
  }
  if (typeof target.versionRange !== 'string' || target.versionRange.length === 0) {
    throw new Error('stent: patch target.versionRange must be a non-empty string')
  }
  const hasFilePath = typeof target.filePath === 'string' || target.filePath instanceof RegExp
  if (!hasFilePath && target.filePaths === undefined) {
    throw new Error('stent: patch target must carry filePath or filePaths')
  }
  if (hasFilePath && target.filePaths !== undefined) {
    throw new Error('stent: patch target must carry filePath or filePaths, not both')
  }
  if (
    target.filePaths !== undefined &&
    (!Array.isArray(target.filePaths) ||
      target.filePaths.length === 0 ||
      target.filePaths.some(path => typeof path !== 'string' || path.length === 0))
  ) {
    throw new Error('stent: patch target.filePaths must be a non-empty array of non-empty strings')
  }
  if (patch.required !== undefined && typeof patch.required !== 'boolean') {
    throw new Error('stent: patch.required must be a boolean when present')
  }
  if (!isValidIndex(target.index)) {
    throw new Error('stent: patch target.index must be a non-negative integer or null')
  }
  if (!isValidIndex(target.functionQuery?.index)) {
    throw new Error('stent: patch target functionQuery.index must be a non-negative integer or null')
  }
  if (!['before', 'after', 'around', 'replace'].includes(patch.operation)) {
    throw new Error(`stent: unknown operation ${JSON.stringify(patch.operation)}`)
  }
}

/** Whether an index field holds a valid match selector: unset, null (every match), or a non-negative integer. */
function isValidIndex(index: number | null | undefined): boolean {
  return index === undefined || index === null || (Number.isInteger(index) && index >= 0)
}

/** Whether a value is a thenable (the async-target result shape). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

/**
 * Registry of enabled Stent patches with the shared bridge subscription.
 */
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
   * plugin registers or removes a patch. Handler enable/disable changes do
   * not emit events because transformed code dispatches through the runtime.
   */
  onPatchChange(listener: StentPatchChangeListener): () => void {
    this.patchListeners.add(listener)
    return () => {
      this.patchListeners.delete(listener)
    }
  }

  /** Notify all loader subscribers after the registry has changed. */
  private notifyPatchChange(change: StentPatchChange): void {
    for (const listener of this.patchListeners) listener(change)
  }

  /**
   * Register patch metadata; the patch stays disabled until
   * {@link StentRuntime.enable} installs its handler.
   * @param info - validated patch metadata.
   * @param owner - identity of the registration owner; defaults to the patch
   * id for raw-runtime callers. Re-registering an id owned by a different
   * owner fails loud — a patch id is exclusive to one plugin — while the same
   * owner may re-register (an HMR generation takes its plugin's patch back)
   * and transfer {@link PatchEntry.fiber fiber} ownership.
   * @param fiber - the fiber whose disposal owns the entry's removal; the
   * Cordis service passes the registering fiber so its disposer can check
   * {@link StentRuntime.isOwnedBy}.
   * @returns whether the id was newly registered (false re-registers metadata).
   * @throws when another `replace` patch already claims the same target, or
   * when the id is already registered by a different owner.
   */
  register(info: StentPatchInfo, owner: unknown = info.id, fiber?: unknown): boolean {
    const previous = this.entries.get(info.id)
    if (previous && previous.owner !== owner) {
      throw new Error(
        `stent: patch ${JSON.stringify(info.id)} is already registered by another owner; ` +
          'a patch id is exclusive to one plugin (HMR re-registration reuses the same owner)',
      )
    }
    if (info.operation === 'replace') {
      const key = targetKey(info.target)
      // A re-registration of this id that already holds replace on the same
      // target is the entry itself; every other replace registration must
      // pass the exclusive-target scan (a first registration as `before`
      // must not be able to re-register into an already-claimed replace
      // target by bypassing the check).
      const selfClaim = previous?.info.operation === 'replace' && targetKey(previous.info.target) === key
      if (!selfClaim) {
        for (const [id, existing] of this.entries) {
          if (id === info.id) continue
          if (existing.info.operation === 'replace' && targetKey(existing.info.target) === key) {
            throw new Error(
              `stent: replace patch ${JSON.stringify(info.id)} conflicts with existing ` +
                `replace patch ${JSON.stringify(existing.info.id)} on the same target`,
            )
          }
        }
      }
    }
    this.entries.set(info.id, { info, handler: previous?.handler, owner, fiber })
    const change: StentPatchChange = { type: 'register', id: info.id, current: info }
    if (previous !== undefined) change.previous = previous.info
    this.notifyPatchChange(change)
    return previous === undefined
  }

  /**
   * Install a patch's handler and ensure the bridge subscription exists.
   * @param id - the patch id.
   * @param handler - the trusted runtime handler.
   */
  enable(id: PatchId, handler: StentHandler): void {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`stent: cannot enable unregistered patch ${JSON.stringify(id)}`)
    if (typeof handler !== 'function') {
      // Fail loud at enable (the earliest resolvable point) instead of
      // crashing inside a transformed call when dispatch tries to run it.
      throw new Error(`stent: handler for patch ${JSON.stringify(id)} must be a function`)
    }
    entry.handler = handler
    this.subscribe()
  }

  /**
   * Remove a patch's handler; the bridge subscription (if any) stays alive.
   * @param id - the patch id.
   */
  disable(id: PatchId): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.handler = undefined
  }

  /**
   * Remove a patch entirely. The bridge subscription stays alive so any
   * transformed module already evaluated keeps delegating to the original
   * body rather than publishing into a dead slot.
   * @param id - the patch id.
   */
  remove(id: PatchId): void {
    const previous = this.entries.get(id)
    if (previous === undefined) return
    this.entries.delete(id)
    this.notifyPatchChange({ type: 'remove', id, previous: previous.info })
  }

  /**
   * Whether the given fiber still owns the entry — the identity check a
   * registration disposer runs before removing, so a stale generation's
   * cleanup cannot unregister a newer registration that took the entry over.
   * @param id - the patch id.
   * @param fiber - the fiber token the registering service passed.
   * @returns true while the entry exists and is owned by that fiber.
   */
  isOwnedBy(id: PatchId, fiber: unknown): boolean {
    const entry = this.entries.get(id)
    return entry !== undefined && entry.fiber === fiber
  }

  /**
   * Whether a patch is currently registered and enabled.
   * @param id - the patch id.
   * @returns true when the patch has an active handler.
   */
  isEnabled(id: PatchId): boolean {
    return this.entries.get(id)?.handler !== undefined
  }

  /**
   * Record load-time bindings for a patch: the files its transform actually
   * rewrote. The transformation hooks call this once per transformed file;
   * records append, so one patch accumulates one entry per file across the
   * process lifetime (re-transforms of the same file append again).
   * @param id - the patch id the bindings belong to.
   * @param records - per-file binding records.
   */
  recordBindings(id: PatchId, records: readonly StentBinding[]): void {
    const existing = this.bindings.get(id)
    if (existing) existing.push(...records)
    else this.bindings.set(id, [...records])
  }

  /**
   * Snapshot of a patch's recorded load-time bindings.
   * @param id - the patch id.
   * @returns the recorded bindings, or an empty array when none were recorded.
   */
  bindingsOf(id: PatchId): readonly StentBinding[] {
    return this.bindings.get(id) ?? []
  }

  /**
   * Snapshot of every recorded binding, flattened in patch-id order.
   * @returns all recorded bindings across patches.
   */
  allBindings(): readonly StentBinding[] {
    return [...this.bindings.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([, records]) => records)
  }

  /**
   * Ordered diagnostic snapshot of all registered patches.
   * @returns the patch infos sorted by priority then id, each carrying its
   * recorded load-time bindings.
   */
  list(): StentPatchInfo[] {
    return [...this.entries.values()]
      .map(entry => ({ ...entry.info, enabled: entry.handler !== undefined, bindings: this.bindingsOf(entry.info.id) }))
      .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  private subscribe(): void {
    if (this.subscribed) return
    this.subscribed = true
    subscribeBridge(call => {
      const entry = this.entries.get(call.id)
      if (!entry) return call.traced()
      return dispatch(entry, call)
    })
  }
}

/** Stable identity of a patch target for conflict detection. */
function targetKey(target: StentTarget): string {
  const selector = target.astQuery ?? JSON.stringify(target.functionQuery ?? null)
  const files = target.filePath ?? (target.filePaths === undefined ? null : target.filePaths.join('|'))
  return [target.module, target.versionRange, String(files), selector].join('|')
}

/**
 * Run the enabled handler for one transformed call. `before` mutates
 * arguments then delegates; `after` delegates then mutates the result;
 * `around` and `replace` decide whether the original body runs and may
 * supply their own result.
 * @param entry - the patch's runtime state.
 * @param call - the call record published by the transform.
 * @returns the value the wrapped function should return: the handler's
 * result for `around`/`replace`, the traced body's result otherwise.
 */
function dispatch(entry: PatchEntry, call: StentBridgeCall): unknown {
  const handler = entry.handler
  if (!handler) return call.traced()
  // The handler union's members are distinguished only by their arity; the
  // operation switch selects the calling convention at runtime.
  const observe = handler as (call: StentCall) => unknown

  const record: StentCall = {
    arguments: call.arguments,
    self: call.self,
  }
  const invoke = (): unknown => call.traced()

  switch (entry.info.operation) {
    case 'before': {
      observe(record)
      return invoke()
    }
    case 'after': {
      const result = invoke()
      if (isThenable(result)) {
        // Async target: rewrite after the promise settles. The caller already
        // holds the original promise, so the rewritten promise is returned
        // and the caller's await resolves to the final value. A handler that
        // returns `undefined` keeps the (possibly in-place mutated)
        // `record.result`, mirroring the sync branch below.
        return result.then(value => {
          record.result = value
          const rewritten = observe(record)
          return rewritten === undefined ? record.result : rewritten
        })
      }
      record.result = result
      const rewritten = observe(record)
      return rewritten === undefined ? record.result : rewritten
    }
    case 'around':
    case 'replace': {
      // The handler union is a plain intersection of callable signatures;
      // `around` and `replace` share the two-argument calling convention.
      return handler(record, invoke)
    }
  }
}

/** Singleton runtime shared by the Cordis service and the transform hooks. */
export const runtime = new StentRuntime()
