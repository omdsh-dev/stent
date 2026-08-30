/**
 * The Stent Client API module: a stable, Mod-facing surface for client commands
 * and named UI slots over the browser command and slot services.
 *
 * The facade delegates to `@deepseek-ai/dsh-client-ui-commands`
 * (`ctx.commandUi`) and `@deepseek-ai/dsh-client-ui-slots` (`ctx.slots`). It
 * exposes no raw DOM access, transport internals, or Host capabilities: render
 * contributions stay pure over their declared inputs, and Host/Web
 * communication uses the existing contracts owned by those services. The
 * complete slot type machinery (SlotMap declaration merging, composed props)
 * lives in `dsh-client-ui-slots`; this facade only narrows the registration
 * face.
 *
 * @module @oh-my-dsh/stent-dsh/browser/client
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {
  SlotEntryDef,
  SlotLabel,
  SlotSpec,
  StoreDecl,
} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Stent Client API, provided by this package. */
    stentClient: StentClientService
  }
}

/**
 * Narrow registration face for one UI-slot contribution.
 *
 * The shape is a stable Mod-facing subset of the slot registration options; the
 * authoritative type machinery (declaration merging, composed-props inference,
 * renders checks) remains in `dsh-client-ui-slots`. The `inject` factory uses
 * an untyped parameter list because the parameter types derive from the slot
 * declaration, which this facade intentionally does not re-derive.
 */
interface StentSlotOptions {
  /** The declared slot name to contribute to. */
  readonly name: string
  /** Child-slot declaration table: keys are the declared (and claimed) holes. */
  readonly children?: Record<string, SlotSpec<SlotEntryDef>>
  /** Optional store seat whose handle joins the composed props. */
  readonly store?: StoreDecl
  /** Optional business-face factory; parameters derive from the declaration. */
  /* oxlint-disable-next-line typescript/no-explicit-any --
   * narrow-contract position only; the authoritative typing lives in the
   * slot service's public overloads, which this face does not re-derive. */
  readonly inject?: ((...args: any[]) => Record<string, unknown>) | undefined
  /** Keyed-kind slot key (required for keyed slots). */
  readonly key?: string
  /** List-kind item id (required for list slots). */
  readonly id?: string
  /** List-kind ordering. */
  readonly order?: number
  /** List-kind label. */
  readonly label?: SlotLabel
  /** Chain-kind routing priority. */
  readonly priority?: number
}

/**
 * One claimant's handle on an arbitrated keyed slot.
 *
 * `owner: true` — the component is registered and renders; disposing removes it
 * and hands the key to the next waiting claimant. `owner: false` — nothing was
 * registered (a higher-priority or earlier claimant owns the key); the claim
 * stays queued and becomes owner when the current owner disposes, at which
 * point the component registers and `onGain` fires. Disposing a queued claim
 * just withdraws it.
 */
interface SlotClaim {
  /** Whether this claim currently owns (and registers) the keyed slot. */
  readonly owner: boolean
  /**
   * Withdraw the claim: remove the registration (when owner) or leave the
   * queue.
   */
  dispose(): void
}

/**
 * Registration face for the arbitrated keyed-slot method. Adds the arbitration
 * declarations to the narrow {@link StentSlotOptions} face.
 */
interface KeyedSlotOptions extends StentSlotOptions {
  /**
   * Arbitration priority: the highest-priority claimant owns the key. Equal
   * priorities keep registration order (the earlier claimant owns) and log a
   * warning naming both plugins. Defaults to 0.
   */
  readonly priority?: number
  /**
   * Optional plugin name, used in arbitration warnings and the winner info
   * handed to a losing owner.
   */
  readonly plugin?: string
  /** Fires when a queued claim becomes owner (the previous owner disposed). */
  readonly onGain?: () => void
  /**
   * Fires when an owning claim loses the key to a higher-priority claimant. The
   * incumbent's registration is NOT force-disposed — it may dispose itself.
   */
  readonly onLost?: (winner: { plugin?: string }) => void
}

/** One claim in the per-key arbitration table. */
interface KeyedClaim {
  readonly options: KeyedSlotOptions
  readonly component: unknown
  /** Whether the claim currently owns the key (its component is registered). */
  owner: boolean
  /** The slot registration's disposer, when the claim is owner. */
  registered: (() => void) | undefined
}

/**
 * Cooperative Mod-facing browser API.
 *
 * Every registration returns the exact disposer of the underlying service and
 * keeps its conflict and disposal semantics. The service never stores a
 * parallel copy of command or slot state.
 */
class StentClientService extends Service {
  /** Service key under which this class registers on `ctx`. */
  static provide = 'stentClient'
  /** The browser command and slot services must be mounted. */
  static inject = ['commandUi', 'slots']

  /**
   * Per (slot name, key) arbitration table: owner first, claimants in
   * registration order.
   */
  private readonly keyed = new Map<string, KeyedClaim[]>()

  /**
   * Create and install the Client API.
   *
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'stentClient')
  }

  /**
   * Register one client command contribution.
   *
   * @param contribution - Slash-menu entry whose behavior lives entirely on the
   *   client.
   * @returns The exact effect disposer that unregisters it.
   */
  registerCommand(contribution: CommandContribution): () => void {
    return this.ctx.commandUi.register(contribution)
  }

  /**
   * Contribute a component to a declared slot and optionally declare child
   * slots.
   *
   * @param options - The narrow registration face (see
   *   {@link StentSlotOptions}).
   * @param component - Component honoring the composed-props contract of the
   *   declared slot.
   * @returns The disposer removing the registration and its declarations.
   */
  registerSlot(options: StentSlotOptions, component: unknown): () => void {
    // The public slot-registration overloads derive their slot names from the
    // merged SlotMap, visible only in packages that import the declaring
    // client plugin; this facade intentionally exposes a stable narrow face
    // instead. The call targets the implementation signature, which accepts
    // the same fields.
    return this.registerComponent(options, component)
  }

  private registerComponent(
    options: StentSlotOptions,
    component: unknown,
  ): () => void {
    return (
      this.ctx.slots as unknown as {
        register(options: StentSlotOptions, component: unknown): () => void
      }
    ).register(options, component)
  }

  private shouldOwn(
    current: KeyedClaim | undefined,
    priority: number,
  ): boolean {
    if (current === undefined) {
      return true
    }
    return priority > (current.options.priority ?? 0)
  }

  private displace(current: KeyedClaim, winner: KeyedClaim): void {
    current.owner = false
    const plugin = winner.options.plugin
    if (plugin === undefined) {
      current.options.onLost?.({})
      return
    }
    current.options.onLost?.({ plugin })
  }

  private takeOwnership(
    claims: KeyedClaim[],
    claim: KeyedClaim,
    current: KeyedClaim | undefined,
  ): void {
    if (current !== undefined) {
      this.displace(current, claim)
    }
    claim.owner = true
    claim.registered = this.registerComponent(claim.options, claim.component)
    claims.unshift(claim)
  }

  private queueClaim(
    claims: KeyedClaim[],
    claim: KeyedClaim,
    current: KeyedClaim | undefined,
    priority: number,
  ): void {
    if (current !== undefined && priority === (current.options.priority ?? 0)) {
      this.ctx.logger.warn(
        `stent-client: keyed slot "${claim.options.name}" key "${claim.options.key}" claimed by both `
          + `${current.options.plugin ?? 'an earlier claimant'} (earlier) and ${claim.options.plugin ?? 'this claimant'}; the earlier one owns it`,
      )
    }
    claims.push(claim)
  }

  /**
   * Contribute to a keyed slot through arbitration.
   *
   * The host invariant stays: exactly one owner renders the key, decided here
   * by declared priority instead of mount timing. The highest-priority claimant
   * registers immediately (owner: true); every other claimant registers nothing
   * and queues (owner: false), taking over automatically when the current owner
   * disposes. Equal priorities keep registration order and log a warning naming
   * both plugins. A later higher-priority claimant displaces the incumbent
   * WITHOUT force-disposing it — the incumbent's `onLost` fires and it may
   * dispose itself.
   *
   * @param options - The keyed registration face with arbitration fields.
   * @param component - Component honoring the composed-props contract of the
   *   declared slot.
   * @returns The claim handle.
   * @throws When `options.key` is missing or the slot host rejects the
   *   registration.
   */
  registerKeyedSlot(options: KeyedSlotOptions, component: unknown): SlotClaim {
    const key = options.key
    if (key === undefined) {
      throw new Error('stent-client: registerKeyedSlot needs options.key')
    }
    const id = `${options.name}\u0000${key}`
    const claims = this.keyed.get(id) ?? []
    const claim: KeyedClaim = {
      options,
      component,
      owner: false,
      registered: undefined,
    }
    const current = claims.find((candidate) => candidate.owner)
    const priority = options.priority ?? 0
    if (this.shouldOwn(current, priority)) {
      this.takeOwnership(claims, claim, current)
    } else {
      this.queueClaim(claims, claim, current, priority)
    }
    this.keyed.set(id, claims)
    return {
      get owner(): boolean {
        return claim.owner
      },
      dispose: () => {
        this.withdraw(id, claim)
      },
    }
  }

  /**
   * Remove a claim: unregister when it owned the key, then promote the next
   * waiting claimant.
   */
  private withdraw(id: string, claim: KeyedClaim): void {
    const claims = this.keyed.get(id)
    if (claims === undefined) {
      return
    }
    const index = claims.indexOf(claim)
    if (index === -1) {
      return
    }
    claims.splice(index, 1)
    if (claim.registered !== undefined) {
      claim.registered()
      claim.registered = undefined
    }
    if (claim.owner) {
      this.promote(claims)
    }
    if (claims.length === 0) {
      this.keyed.delete(id)
    }
  }

  /**
   * Hand the key to the first waiting claimant. A displaced incumbent already
   * has its component mounted and only regains the ownership flag.
   */
  private promote(claims: KeyedClaim[]): void {
    const next = claims.find((candidate) => !candidate.owner)
    if (next === undefined) {
      return
    }
    next.owner = true
    if (next.registered === undefined) {
      next.registered = this.registerComponent(next.options, next.component)
    }
    next.options.onGain?.()
  }
}

/** Cordis plugin name used by Loader diagnostics. */
const name = 'stent-dsh'

/**
 * Mount the Stent Client API for the browser Cordis tree.
 *
 * @param ctx - Cordis context that owns the service.
 */
async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(StentClientService)
  if (ctx.get('stentClient') === undefined) {
    throw new Error('stent-dsh: browser client service failed to mount')
  }
}

export type { StentSlotOptions, SlotClaim, KeyedSlotOptions }
export { StentClientService, name, apply }
