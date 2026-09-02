/**
 * The Stent compat adapter module: a patch-backed gap adapter that turns a
 * low-level Stent transformation into a cooperative observation API.
 *
 * The adapter exists for target domains with no cooperative extension point (no
 * event, no registry): their target metadata is declared in the compat
 * configuration and registered dynamically by this service. The runtime loader
 * must be installed before the target module is imported. The constructor
 * claims each declared target's metadata with a disabled placeholder;
 * `observe()` only swaps in the live listener handler. The public contract
 * stays cooperative — `observe(name, listener)` — and never exposes
 * `StentPatch`, AST selectors, file paths, or `invoke()`. Target version drift
 * leaves the adapter unavailable rather than pretending compatibility: the
 * registered metadata simply never matches, and the service's diagnostics
 * surface the declared target.
 *
 * @module @oh-my-dsh/stent-api/compat/service
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  PatchId,
  StentCall,
  StentHandler,
  StentPatch,
  StentService,
} from '@oh-my-dsh/stent'
import { getStent, isStentInstalled } from '@oh-my-dsh/stent'
import type { ServeBrowserTransformOptions } from '@oh-my-dsh/stent/browser'
import { serveBrowserTransform } from '@oh-my-dsh/stent/browser'

import type { StentCompatConfig, StentCompatTarget } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent compat adapter, provided by this package. */
    stentCompat: StentCompatService
  }
}

/** Listener-set size at which a declared target's patch is enabled or disabled. */
const NO_LISTENERS = 0

/**
 * One observation listener registered through
 * {@link StentCompatService.observe}.
 */
type StentCompatObserver = (call: StentCall) => void

class StentCompatService extends Service {
  /** Service key under which this class registers on `ctx`. */
  public static provide = 'stentCompat'

  /** The low-level Stent registry this facade drives (mounted on demand). */
  private readonly stent: StentService
  /**
   * The fiber that mounted this facade (this fiber's parent): the ownership
   * token the low-level registry records for every registration made through
   * this service, and the token this service's disposers check before disabling
   * — so a stale HMR generation's cleanup cannot disable a newer generation's
   * registration.
   */
  private readonly ownerFiber: Fiber
  private readonly targets = new Map<string, StentCompatTarget>()
  /** Patch ids claimed by the declared observation targets (a stable namespace). */
  private readonly targetIds = new Set<PatchId>()
  /** Runtime patch ids registered through this service. */
  private readonly registered = new Set<PatchId>()
  private readonly observers = new Map<string, Set<StentCompatObserver>>()

  /**
   * Create and install the compat adapter.
   *
   * @param ctx - Cordis context that owns the service.
   * @param config - Declared observation targets; duplicate names fail loud.
   */
  public constructor(ctx: Context, config: StentCompatConfig) {
    super(ctx, 'stentCompat')
    /* The low-level registry is optional and mounted on demand: a consumer
       mounts this facade alone and never imports the low-level package. It
       resolves from the MOUNTING fiber's context (this fiber's parent), so
       patch registrations are owned by the plugin that mounted the facade —
       the identity the low-level service uses to keep a patch id exclusive
       to one owner across HMR generations — instead of by this child fiber. */
    const owner = ctx.fiber.parent
    this.ownerFiber = owner.fiber
    this.stent = getStent(owner)
    for (const target of config.targets ?? []) {
      this.claimTarget(target)
    }
  }

  /**
   * Claim one declared target's metadata with a disabled placeholder.
   *
   * The claim happens while the facade mounts, before target modules are
   * evaluated. The placeholder stays disabled until the first observer
   * subscribes; this keeps observation lazy without a static installer.
   *
   * @param target - The declared observation target.
   * @throws When the target name or its patch id is declared twice.
   */
  private claimTarget(target: StentCompatTarget): void {
    if (this.targets.has(target.name)) {
      throw new Error(
        `stent-compat: target "${target.name}" is declared more than once`,
      )
    }
    if (this.targetIds.has(target.patch.id)) {
      throw new Error(
        `stent-compat: patch id "${target.patch.id}" is declared more than once`,
      )
    }
    this.targets.set(target.name, target)
    this.targetIds.add(target.patch.id)
    this.stent.register({
      id: target.patch.id,
      target: target.patch.target,
      operation: target.patch.operation,
      handler: () => {
        /* Placeholder claim: observe() swaps in the live listener handler. */
      },
    })
    this.stent.disable(target.patch.id)
  }

  /**
   * Register a runtime patch through the cooperative facade.
   *
   * The facade owns an exclusive id namespace: registering an id that is
   * already claimed — by another registration or by a declared observation
   * target — fails loud, where the low-level registry would silently update the
   * existing patch. The patch is enabled immediately and removed with the
   * calling fiber (the low-level registration is the fiber's effect); the
   * low-level registry additionally rejects an id already owned by a different
   * plugin, so the exclusivity holds across facade instances too.
   *
   * @param patch - The patch descriptor with its trusted handler.
   * @returns The registered patch id.
   * @throws When the id is already claimed.
   */
  public registerPatch(patch: StentPatch): PatchId {
    if (this.registered.has(patch.id) || this.targetIds.has(patch.id)) {
      throw new Error(
        `stent-compat: patch id "${patch.id}" is already claimed (registerPatch or a declared observation target)`,
      )
    }
    /* No bridge check here: binding a handler is harmless when the
       transforms are absent (the low-level registry has the same posture) —
       the bridge check belongs to observe, whose contract promises delivery. */
    this.stent.register(patch)
    this.registered.add(patch.id)
    return patch.id
  }

  /**
   * Disable and remove a patch registered through this service.
   *
   * Removal frees the id for re-registration and empties the runtime entry, so
   * a later registration starts a fresh ownership cycle instead of inheriting
   * this one's disposal effect.
   *
   * @param id - The patch id.
   */
  public unregisterPatch(id: PatchId): void {
    if (!this.registered.has(id)) {
      return
    }
    this.stent.disable(id)
    this.stent.remove(id)
    this.registered.delete(id)
  }

  /**
   * Disable a registered patch's handler; transformed code delegates to the
   * original body until the patch is enabled again.
   *
   * @param id - The patch id.
   */
  public disablePatch(id: PatchId): void {
    this.stent.disable(id)
  }

  /**
   * Enable a previously disabled registered patch with a fresh handler.
   *
   * @param id - The patch id.
   * @param handler - The trusted runtime handler.
   */
  public enablePatch(id: PatchId, handler: StentHandler): void {
    this.stent.enable(id, handler)
  }

  /**
   * Serve a transformed browser bundle through the runtime bundle primitive —
   * the cooperative entry for browser-side bundle rewrites (the low-level
   * {@link serveBrowserTransform} under the facade).
   *
   * @param options - Route, patches array, and degradation policy.
   * @returns A disposer removing the route.
   */
  public serveBundle(options: ServeBrowserTransformOptions): () => void {
    return serveBrowserTransform(this.ctx, options)
  }

  /**
   * Resolve a declared target that is ready to be observed.
   *
   * Fails loud when the Stent bridge is not installed: resolving `ctx.stent`
   * alone does not imply the load-time hooks or browser bridge are active, and
   * an adapter must not register a patch that can never take effect.
   *
   * @param name - The declared target name.
   * @returns The declared target.
   * @throws When the name is unknown or the Stent bridge is not installed.
   */
  private resolveTarget(name: string): StentCompatTarget {
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
    return target
  }

  /**
   * Observe calls to a declared target.
   *
   * Fails loud when the Stent bridge is not installed (see
   * {@link StentCompatService.resolveTarget}). The low-level registration is
   * owned by the plugin that mounted this facade; another plugin's observe of
   * the same target patch id fails loud at the low-level registry (a patch id
   * is exclusive to one owner).
   *
   * @param name - The declared target name.
   * @param listener - Called with each observed call record.
   * @returns A disposer removing this listener (the patch stays enabled while
   *   other listeners remain).
   */
  public observe(name: string, listener: StentCompatObserver): () => void {
    const target = this.resolveTarget(name)
    const listeners = this.observers.get(name) ?? new Set<StentCompatObserver>()
    if (listeners.size === NO_LISTENERS) {
      /* First listener for this name: enable the metadata claimed during
         construction. The listener joins only after the claim/enable step so
         a cross-owner failure cannot leave stale listener state behind. */
      this.stent.enable(target.patch.id, (call: StentCall) => {
        const current = [...listeners]
        for (const observer of current) {
          observer(call)
        }
      })
    }
    listeners.add(listener)
    this.observers.set(name, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === NO_LISTENERS) {
        this.observers.delete(name)
        /* Only disable while this facade's generation still owns the patch:
           a newer HMR generation may have taken the entry over, and its
           observation must survive this cleanup. */
        if (this.stent.owns(target.patch.id, this.ownerFiber)) {
          this.stent.disable(target.patch.id)
        }
      }
    }
  }
}

export { StentCompatService }
export type {
  StentCompatConfig,
  StentCompatPatch,
  StentCompatTarget,
} from './types.ts'
export type {
  PatchId,
  StentCall,
  StentHandler,
  StentInvoke,
  StentOperation,
  StentPatch,
  StentTarget,
} from '@oh-my-dsh/stent'
export type { ServeBrowserTransformOptions } from '@oh-my-dsh/stent/browser'
