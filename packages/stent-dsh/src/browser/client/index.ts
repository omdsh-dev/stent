/**
 * The Stent Client API module: a stable, Mod-facing surface for client commands
 * and named UI slots over `ctx.commandUi` (@deepseek-ai/dsh-client-ui-commands)
 * and `ctx.slots` (@deepseek-ai/dsh-client-ui-slots). It exposes no raw DOM
 * access, transport internals, or Host capabilities, and the complete slot type
 * machinery (SlotMap merging, composed props) stays in `dsh-client-ui-slots`.
 *
 * @module @oh-my-dsh/stent-dsh/browser/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
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

/* Arbitration default and array sentinels for the per-key claim table. */
const DEFAULT_PRIORITY = 0
const NOT_FOUND = -1
const ONE_CLAIM = 1
/** The effect disposer every registration in this facade hands back. */
type Dispose = () => void

/**
 * Narrow registration face for one UI-slot contribution: a Mod-facing subset of
 * the slot registration options. The authoritative type machinery (declaration
 * merging, composed-props inference, renders checks) stays in the slot
 * service.
 */
interface StentSlotOptions {
  /** The declared slot name to contribute to. */
  readonly name: string
  /** Child-slot declarations: keys are the declared (and claimed) holes. */
  readonly children?: Record<string, SlotSpec<SlotEntryDef>>
  /** Optional store seat whose handle joins the composed props. */
  readonly store?: StoreDecl
  /** Optional business-face factory; parameters derive from the declaration. */
  readonly inject?: ((...args: any[]) => Record<string, unknown>) | undefined
  /* Kind-specific fields: keyed slots need `key`, list slots need `id` and may
     set `order`/`label`, and chain slots route by `priority`. */
  readonly key?: string
  readonly id?: string
  readonly order?: number
  readonly label?: SlotLabel
  readonly priority?: number
}

/**
 * One claimant's handle on an arbitrated keyed slot: an owner renders and hands
 * the key on when disposed, while a queued claim registered nothing and takes
 * over (firing `onGain`) once the owner disposes.
 */
interface SlotClaim {
  /** Whether this claim currently owns (and registers) the keyed slot. */
  readonly owner: boolean
  /** Withdraw the claim: remove the registration (owner) or leave the queue. */
  readonly dispose: Dispose
}

/** Keyed-slot face: {@link StentSlotOptions} plus arbitration fields. */
interface KeyedSlotOptions extends StentSlotOptions {
  /**
   * Arbitration priority: the highest-priority claimant owns the key; equal
   * priorities keep registration order and log a warning naming both plugins.
   */
  readonly priority?: number
  /** Plugin name used in arbitration warnings and in the winner info below. */
  readonly plugin?: string
  /** Fires when a queued claim becomes owner (the previous owner disposed). */
  readonly onGain?: () => void
  /** Fires when a higher-priority claimant takes the key; no force-dispose. */
  readonly onLost?: (winner: { readonly plugin?: string }) => void
}

/** One claim in the per-key table; `owner` gates its live registration. */
interface KeyedClaim {
  readonly options: KeyedSlotOptions
  readonly component: unknown
  owner: boolean
  registered: Dispose | undefined
}

/**
 * The slot service's implementation signature; its public overloads derive slot
 * names from a merged SlotMap this facade does not re-derive.
 */
interface SlotRegistrar {
  readonly register: (spec: StentSlotOptions, node: unknown) => Dispose
}

/** Narrow the mounted slot service to the registration face used here. */
function isSlotRegistrar(value: unknown): value is SlotRegistrar {
  return (
    typeof value === 'object'
    && value !== null
    && 'register' in value
    && typeof value.register === 'function'
  )
}

/** The claim that currently owns the key, when the table has one. */
function ownerOf(claims: readonly KeyedClaim[]): KeyedClaim | undefined {
  for (const candidate of claims) {
    if (candidate.owner) {
      return candidate
    }
  }
  return undefined
}

/** The claim's declared arbitration priority. */
function priorityOf(claim: KeyedClaim): number {
  const configured = claim.options.priority
  if (configured === undefined || configured === null) {
    return DEFAULT_PRIORITY
  }
  return configured
}

/** Whether a claim of `priority` outranks the key's current owner. */
function shouldOwn(current: KeyedClaim | undefined, priority: number): boolean {
  if (current === undefined) {
    return true
  }
  const currentPriority = priorityOf(current)
  return priority > currentPriority
}

/** Tell a displaced owner who took the key; its registration stays mounted. */
function displace(current: KeyedClaim, winner: KeyedClaim): void {
  current.owner = false
  const { plugin } = winner.options
  if (plugin === undefined) {
    current.options.onLost?.({})
    return
  }
  current.options.onLost?.({ plugin })
}

/**
 * Cooperative Mod-facing browser API: every registration returns the exact
 * disposer of the underlying service and keeps its conflict and disposal
 * semantics, and no parallel copy of command or slot state is kept here.
 */
class StentClientService extends Service {
  /** Service key under which this class registers on `ctx`. */
  public static provide = 'stentClient'
  /** The browser command and slot services must be mounted. */
  public static inject = ['commandUi', 'slots']

  /** Per (slot name, key) table: owner first, then claimants in order. */
  private readonly keyed = new Map<string, KeyedClaim[]>()

  /** Create and install the Client API on the `ctx` that owns the service. */
  public constructor(ctx: Context) {
    super(ctx, 'stentClient')
  }

  /** Register one client command contribution; returns its effect disposer. */
  public registerCommand(contribution: CommandContribution): Dispose {
    return this.ctx.commandUi.register(contribution)
  }

  /** Contribute a component to a declared slot and declare its child slots. */
  public registerSlot(options: StentSlotOptions, component: unknown): Dispose {
    return this.registerComponent(options, component)
  }

  /** Reach the slot host through its implementation signature. */
  private registerComponent(spec: StentSlotOptions, node: unknown): Dispose {
    const slots: unknown = this.ctx.slots
    if (!isSlotRegistrar(slots)) {
      throw new Error('stent-client: ctx.slots exposes no register()')
    }
    return slots.register(spec, node)
  }

  /**
   * Contribute to a keyed slot through arbitration: exactly one owner renders
   * the key, decided by declared priority instead of mount timing. Losers
   * register nothing and queue, taking over when the owner disposes; equal
   * priorities keep registration order and warn. A higher-priority latecomer
   * displaces the incumbent WITHOUT force-disposing it — `onLost` fires and the
   * incumbent may dispose itself.
   *
   * @throws When `options.key` is missing or the slot host rejects it.
   */
  public registerKeyedSlot(
    options: KeyedSlotOptions,
    component: unknown,
  ): SlotClaim {
    const { key } = options
    if (key === undefined) {
      throw new Error('stent-client: registerKeyedSlot needs options.key')
    }
    const id = `${options.name}\u0000${key}`
    const claim: KeyedClaim = {
      options,
      component,
      owner: false,
      registered: undefined,
    }
    this.arbitrate(id, claim)
    return {
      get owner(): boolean {
        return claim.owner
      },
      dispose: () => {
        this.withdraw(id, claim)
      },
    }
  }

  /** Add a claim to its key's table: take the key or queue behind the owner. */
  private arbitrate(id: string, claim: KeyedClaim): void {
    const claims = this.keyed.get(id) ?? []
    if (shouldOwn(ownerOf(claims), priorityOf(claim))) {
      this.takeOwnership(claims, claim)
    } else {
      this.queueClaim(claims, claim)
    }
    this.keyed.set(id, claims)
  }

  /** Register the newcomer's component and put it at the head of the table. */
  private takeOwnership(claims: KeyedClaim[], claim: KeyedClaim): void {
    const current = ownerOf(claims)
    if (current !== undefined) {
      displace(current, claim)
    }
    claim.owner = true
    claim.registered = this.registerComponent(claim.options, claim.component)
    claims.unshift(claim)
  }

  /** Queue the newcomer behind the owner, warning on an equal priority. */
  private queueClaim(claims: KeyedClaim[], claim: KeyedClaim): void {
    const current = ownerOf(claims)
    if (current !== undefined && priorityOf(claim) === priorityOf(current)) {
      this.ctx.logger.warn(
        `stent-client: keyed slot "${claim.options.name}" key "${claim.options.key}" claimed by both `
          + `${current.options.plugin ?? 'an earlier claimant'} (earlier) and ${claim.options.plugin ?? 'this claimant'}; the earlier one owns it`,
      )
    }
    claims.push(claim)
  }

  /** Remove a claim, then promote the next waiting claimant when it owned. */
  private withdraw(id: string, claim: KeyedClaim): void {
    const claims = this.keyed.get(id)
    const index = claims?.indexOf(claim) ?? NOT_FOUND
    if (claims === undefined || index === NOT_FOUND) {
      return
    }
    claims.splice(index, ONE_CLAIM)
    this.release(claims, claim)
    if (claims.length < ONE_CLAIM) {
      this.keyed.delete(id)
    }
  }

  /** Drop the claim's registration and hand the key on when it owned one. */
  private release(claims: KeyedClaim[], claim: KeyedClaim): void {
    if (claim.registered !== undefined) {
      claim.registered()
      claim.registered = undefined
    }
    if (claim.owner) {
      this.promote(claims)
    }
  }

  /** Hand the key on; a displaced incumbent only regains the ownership flag. */
  private promote(claims: KeyedClaim[]): void {
    const next = claims.find((candidate) => !candidate.owner)
    if (next === undefined) {
      return
    }
    next.owner = true
    next.registered ??= this.registerComponent(next.options, next.component)
    next.options.onGain?.()
  }
}

/** Cordis plugin name used by Loader diagnostics. */
const name = 'stent-dsh'

/** Mount the Stent Client API for the browser Cordis tree. */
async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(StentClientService)
  if (ctx.get('stentClient') === undefined) {
    throw new Error('stent-dsh: browser client service failed to mount')
  }
}

export type { StentSlotOptions, SlotClaim, KeyedSlotOptions }
export { StentClientService, name, apply }
