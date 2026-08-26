/**
 * The Stent compat adapter module: a patch-backed gap adapter that turns a
 * low-level Stent transformation into a cooperative observation API.
 *
 * The adapter exists for target domains with no cooperative extension point
 * (no event, no registry): their target metadata is declared in the compat
 * configuration and registered dynamically by this service. The runtime
 * loader must be installed before the target module is imported. The
 * constructor claims each declared target's metadata with a disabled
 * placeholder; `observe()` only swaps in the live listener handler.
 * The public contract stays cooperative — `observe(name, listener)` — and
 * never exposes `StentPatch`, AST selectors, file paths, or `invoke()`.
 * Target version drift leaves the adapter unavailable rather than pretending
 * compatibility: the registered metadata simply never matches, and the
 * service's diagnostics surface the declared target.
 * @module @oh-my-dsh/stent-api/compat/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { getStent, isStentInstalled } from '@oh-my-dsh/stent'
import { serveBrowserTransform } from '@oh-my-dsh/stent/browser'
import type { ServeBrowserTransformOptions } from '@oh-my-dsh/stent/browser'
import type { StentService, StentCall, StentHandler, StentPatch, PatchId } from '@oh-my-dsh/stent'
import type { StentCompatConfig, StentCompatTarget } from './types.ts'

export type { StentCompatConfig, StentCompatPatch, StentCompatTarget } from './types.ts'

export type {
  StentCall,
  StentHandler,
  StentInvoke,
  StentOperation,
  StentPatch,
  StentTarget,
  PatchId,
} from '@oh-my-dsh/stent'
export type { ServeBrowserTransformOptions } from '@oh-my-dsh/stent/browser'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent compat adapter, provided by this package. */
    stentCompat: StentCompatService
  }
}

export class StentCompatService extends Service {
  /** Service key under which this class registers on `ctx`. */
  static provide = 'stentCompat'

  /** The low-level Stent registry this facade drives (mounted on demand). */
  private readonly stent: StentService
  /**
   * The fiber that mounted this facade (this fiber's parent): the ownership
   * token the low-level registry records for every registration made through
   * this service, and the token this service's disposers check before
   * disabling — so a stale HMR generation's cleanup cannot disable a newer
   * generation's registration.
   */
  private readonly ownerFiber: Fiber
  private readonly targets = new Map<string, StentCompatTarget>()
  /** Patch ids claimed by the declared observation targets (a stable namespace). */
  private readonly targetIds = new Set<PatchId>()
  /** Runtime patch registrations made through this service, by id. */
  private readonly registered = new Map<PatchId, StentPatch>()
  private readonly observers = new Map<string, Set<(call: StentCall) => void>>()

  /**
   * Create and install the compat adapter.
   * @param ctx - Cordis context that owns the service.
   * @param config - declared observation targets; duplicate names fail loud.
   */
  constructor(ctx: Context, config: StentCompatConfig) {
    super(ctx, 'stentCompat')
    // The low-level registry is optional and mounted on demand: a consumer
    // mounts this facade alone and never imports the low-level package. It
    // resolves from the MOUNTING fiber's context (this fiber's parent), so
    // patch registrations are owned by the plugin that mounted the facade —
    // the identity the low-level service uses to keep a patch id exclusive
    // to one owner across HMR generations — instead of by this child fiber.
    const owner = ctx.fiber.parent
    this.ownerFiber = owner.fiber
    this.stent = getStent(owner)
    for (const target of config.targets ?? []) {
      if (this.targets.has(target.name)) {
        throw new Error(`stent-compat: target "${target.name}" is declared more than once`)
      }
      if (this.targetIds.has(target.patch.id)) {
        throw new Error(`stent-compat: patch id "${target.patch.id}" is declared more than once`)
      }
      this.targets.set(target.name, target)
      this.targetIds.add(target.patch.id)
      // Claim the metadata while the facade mounts, before target modules are
      // evaluated. The placeholder stays disabled until the first observer
      // subscribes; this keeps observation lazy without a static installer.
      this.stent.register({
        id: target.patch.id,
        target: target.patch.target,
        operation: target.patch.operation,
        handler: () => undefined,
      })
      this.stent.disable(target.patch.id)
    }
  }

  /**
   * Register a runtime patch through the cooperative facade.
   *
   * The facade owns an exclusive id namespace: registering an id that is
   * already claimed — by another registration or by a declared observation
   * target — fails loud, where the low-level registry would silently update
   * the existing patch. The patch is enabled immediately and removed with
   * the calling fiber (the low-level registration is the fiber's effect);
   * the low-level registry additionally rejects an id already owned by a
   * different plugin, so the exclusivity holds across facade instances too.
   * @param patch - the patch descriptor with its trusted handler.
   * @returns the registered patch id.
   * @throws when the id is already claimed.
   */
  registerPatch(patch: StentPatch): PatchId {
    if (this.registered.has(patch.id) || this.targetIds.has(patch.id)) {
      throw new Error(
        `stent-compat: patch id "${patch.id}" is already claimed (registerPatch or a declared observation target)`,
      )
    }
    // No bridge check here: binding a handler is harmless when the
    // transforms are absent (the low-level registry has the same posture) —
    // the bridge check belongs to observe, whose contract promises delivery.
    this.stent.register(patch)
    this.registered.set(patch.id, patch)
    return patch.id
  }

  /**
   * Disable and remove a patch registered through this service.
   *
   * Removal frees the id for re-registration and empties the runtime entry,
   * so a later registration starts a fresh ownership cycle instead of
   * inheriting this one's disposal effect.
   * @param id - the patch id.
   */
  unregisterPatch(id: PatchId): void {
    if (!this.registered.has(id)) return
    this.stent.disable(id)
    this.stent.remove(id)
    this.registered.delete(id)
  }

  /**
   * Disable a registered patch's handler; transformed code delegates to the
   * original body until the patch is enabled again.
   * @param id - the patch id.
   */
  disablePatch(id: PatchId): void {
    this.stent.disable(id)
  }

  /**
   * Enable a previously disabled registered patch with a fresh handler.
   * @param id - the patch id.
   * @param handler - the trusted runtime handler.
   */
  enablePatch(id: PatchId, handler: StentHandler): void {
    this.stent.enable(id, handler)
  }

  /**
   * Serve a transformed browser bundle through the runtime bundle
   * primitive — the cooperative entry for browser-side bundle rewrites
   * (the low-level {@link serveBrowserTransform} under the facade).
   * @param options - route, patches array, and degradation policy.
   * @returns a disposer removing the route.
   */
  serveBundle(options: ServeBrowserTransformOptions): () => void {
    return serveBrowserTransform(this.ctx, options)
  }

  /**
   * Observe calls to a declared target.
   *
   * Fails loud when the Stent bridge is not installed: resolving `ctx.stent`
   * alone does not imply the load-time hooks or browser bridge are active, and
   * an adapter must not register a patch that can never take effect. The
   * low-level registration is owned by the plugin that mounted this facade;
   * another plugin's observe of the same target patch id fails loud at the
   * low-level registry (a patch id is exclusive to one owner).
   * @param name - the declared target name.
   * @param listener - called with each observed call record.
   * @returns a disposer removing this listener (the patch stays enabled while
   * other listeners remain).
   */
  observe(name: string, listener: (call: StentCall) => void): () => void {
    const target = this.targets.get(name)
    if (target === undefined) {
      throw new Error(
        `stent-compat: unknown target "${name}" (declared targets: ${[...this.targets.keys()].join(', ') || 'none'})`,
      )
    }
    if (!isStentInstalled()) {
      throw new Error(
        'stent-compat: the Stent bridge is not installed; install the dynamic Stent hooks before loading the target module',
      )
    }
    const listeners = this.observers.get(name) ?? new Set<(call: StentCall) => void>()
    if (listeners.size === 0) {
      // First listener for this name: enable the metadata claimed during
      // construction. The listener joins only after the claim/enable step so
      // a cross-owner failure cannot leave stale listener state behind.
      this.stent.enable(target.patch.id, (call: StentCall) => {
        for (const current of [...listeners]) current(call)
      })
    }
    listeners.add(listener)
    this.observers.set(name, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.observers.delete(name)
        // Only disable while this facade's generation still owns the patch:
        // a newer HMR generation may have taken the entry over, and its
        // observation must survive this cleanup.
        if (this.stent.owns(target.patch.id, this.ownerFiber)) {
          this.stent.disable(target.patch.id)
        }
      }
    }
  }
}
