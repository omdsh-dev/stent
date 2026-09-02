/**
 * The Cordis Stent service: the runtime face of the Stent extension layer.
 * Trusted plugins register patches (target + operation + handler) here; the
 * transformation hooks installed by `installStentHooks()` rewrite the target
 * functions, and this service attaches and detaches the handlers in the shared
 * runtime.
 *
 * The service is platform-free (no `node:*` imports) so the same class serves
 * the Node host and the browser Cordis tree. It is opt-in: nothing in the
 * default host composition mounts it, and a plugin only receives `ctx.stent`
 * when it declares the service and the runtime entered through the Stent DSH
 * launch path.
 *
 * @module @oh-my-dsh/stent/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

import { isStentDshLaunch } from './activation.ts'
import { registrationOwner } from './hmr/ownership.ts'
import { runtime, validatePatchId, validatePatchStatic } from './runtime.ts'
import type {
  PatchId,
  StentBinding,
  StentHandler,
  StentPatch,
  StentPatchInfo,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent patch registry, provided by this package. */
    stent: StentService
  }
}

/** Priority of a patch that does not declare one. */
const DEFAULT_PRIORITY = 0

/** Validate the static fields of a patch descriptor. */
function validatePatch(patch: StentPatch): void {
  validatePatchStatic(patch)
  if (typeof patch.handler !== 'function') {
    throw new TypeError('stent: patch.handler must be a function')
  }
  const { target } = patch
  if (target.functionQuery === undefined && target.astQuery === undefined) {
    throw new Error('stent: patch target must carry functionQuery or astQuery')
  }
  if (typeof target.astQuery === 'string' && target.astQuery.trim() === '') {
    throw new Error('stent: patch target astQuery must not be blank')
  }
}

/** Build the immutable runtime info snapshot for a patch. */
function patchInfo(patch: StentPatch): StentPatchInfo {
  const info: StentPatchInfo = {
    id: patch.id,
    target: patch.target,
    operation: patch.operation,
    priority: patch.priority ?? DEFAULT_PRIORITY,
    enabled: true,
  }
  if (patch.required === undefined) {
    return info
  }
  return { ...info, required: patch.required }
}

/**
 * The Stent registry service. Keeps patch metadata and handler state in the
 * process-local runtime and ties every registration to the owning fiber's
 * lifecycle.
 */
class StentService extends Service {
  /** Service key under which this class registers on `ctx`. */
  public static provide = 'stent'

  /** The process-local registry every method of this facade delegates to. */
  private readonly registry = runtime

  /**
   * Stent-dependent plugins only activate in the DSH Stent launch path.
   * Low-level callers can still construct this service explicitly for
   * standalone Stent usage; Cordis injection observes this availability check.
   */
  public [Service.check](): boolean {
    return isStentDshLaunch()
  }

  /**
   * Create and install the Stent registry.
   *
   * @param ctx - Cordis context that owns the service.
   */
  public constructor(ctx: Context) {
    super(ctx, 'stent')
  }

  /**
   * Register a patch and enable its handler for the current fiber.
   *
   * Every registration is an effect on the calling fiber: disposing the fiber
   * disables and removes the patch, so transformed code falls back to the
   * original body. The disposer only removes the entry while this fiber still
   * owns it — a same-owner re-registration (an HMR generation taking its
   * plugin's patch back) transfers fiber ownership, so the previous
   * generation's cleanup becomes a no-op instead of unregistering the newer
   * registration. Registering an id already owned by a different plugin fails
   * loud: a patch id is exclusive to one owner.
   *
   * @param patch - Validated patch descriptor.
   * @returns The registered patch id.
   * @throws When the id is already registered by a different plugin owner.
   */
  public register(patch: StentPatch): PatchId {
    validatePatchId(patch.id)
    validatePatch(patch)
    const { fiber } = this.ctx
    /* The effect goes first: a disposed (or unloading) fiber rejects the
       registration before it can leave a half-installed entry behind, and a
       later cross-owner throw from the runtime still leaves a disposer that
       no-ops (it never owned the entry). */
    this.ctx.effect(
      () => (): void => {
        if (this.registry.isOwnedBy(patch.id, fiber)) {
          this.registry.disable(patch.id)
          this.registry.remove(patch.id)
        }
      },
      `stent:register(${patch.id})`,
    )
    this.registry.register(patchInfo(patch), registrationOwner(this.ctx), fiber)
    this.registry.enable(patch.id, patch.handler)
    return patch.id
  }

  /**
   * Ordered diagnostic snapshot of all registered patches.
   *
   * @returns The patch infos sorted by priority then id.
   */
  public list(): StentPatchInfo[] {
    return this.registry.list()
  }

  /**
   * Disable a patch's handler; transformed code delegates to the original body
   * until the patch is enabled again.
   *
   * @param id - The patch id.
   */
  public disable(id: string): void {
    this.registry.disable(id)
  }

  /**
   * Enable a previously disabled patch with a fresh handler binding.
   *
   * @param id - The patch id.
   * @param handler - The trusted runtime handler.
   */
  public enable(id: string, handler: StentHandler): void {
    this.registry.enable(id, handler)
  }

  /**
   * Remove a patch entirely; transformed code delegates to the original body
   * until the patch is registered again. The registering fiber's effect still
   * owns the entry, so a removal here cannot be undone by a later fiber
   * disposal (the disposer no-ops once the entry is gone).
   *
   * @param id - The patch id.
   */
  public remove(id: string): void {
    this.registry.remove(id)
  }

  /**
   * Whether the entry for a patch id is still owned by the given fiber — the
   * ownership check a cooperative disposer (e.g. the compat facade's observer)
   * runs before disabling, so a stale generation's cleanup cannot disable a
   * newer generation's registration that took the entry over.
   *
   * @param id - The patch id.
   * @param fiber - The fiber token the registration was made on.
   * @returns True while the entry exists and is owned by that fiber.
   */
  public owns(id: string, fiber: unknown): boolean {
    return this.registry.isOwnedBy(id, fiber)
  }

  /**
   * Snapshot of load-time bindings: the files the transformation hooks actually
   * rewrote for one patch — the ground truth the `required` check and this
   * package's diagnostics are built on.
   *
   * @param id - The patch id; when omitted, every recorded binding across
   *   patches, flattened in patch-id order.
   * @returns The recorded binding records.
   */
  public bindings(id?: PatchId): readonly StentBinding[] {
    if (id === undefined) {
      return this.registry.allBindings()
    }
    return this.registry.bindingsOf(id)
  }
}

/**
 * Mount-aware accessor for the optional Stent registry: returns the
 * already-mounted service on this context, or mounts a fresh registry and
 * returns it. Cordis removes the registry with the owning fiber and rejects a
 * second registration, so repeated calls on a live context reuse the mounted
 * service (the context's view of it — a traceable wrapper on plain contexts —
 * never a fresh registry). Declared injection remains the preferred route: this
 * is the documented fallback for plugins that cannot declare the optional
 * service, and it reads the global store strictly, per the optional-service
 * convention.
 *
 * In a DSH process this accessor is launch-gated before it looks up or mounts
 * the service. A plugin that calls `getStent(ctx)` must declare `inject:
 * ['stent']`; otherwise it cannot silently bypass Cordis's pending service gate
 * under plain `dsh` — the call fails loudly instead. Explicit `new
 * StentService(ctx)` remains available to standalone low-level callers that
 * intentionally manage the Stent lifecycle themselves.
 *
 * @param ctx - The Cordis context to read from or mount on.
 * @returns The mounted Stent registry (the context's view).
 * @throws When the process did not enter through the `stent-dsh` launch path.
 */
function getStent(ctx: Context): StentService {
  if (!isStentDshLaunch()) {
    throw new Error(
      'stent: getStent(ctx) requires the stent-dsh launch path; declare inject: ["stent"] for a DSH plugin so Cordis can keep it pending under plain dsh',
    )
  }
  const existing = ctx.get('stent')
  if (existing !== undefined) {
    return existing
  }
  return new StentService(ctx)
}

export { StentService, getStent }
