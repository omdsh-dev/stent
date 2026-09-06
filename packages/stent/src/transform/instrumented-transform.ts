import type { StentInstrumentationConfig } from './config.ts'
import type {
  IdentityResolver,
  StentMatcher,
  TransformOutput,
} from './matcher.ts'
import { createStentMatcher, transformModuleState } from './matcher.ts'

const NO_PENDING_BINDINGS = 0
const BINDING_INCREMENT = 1

/** Owns matcher and binding counters for one instrumented browser transform. */
class InstrumentedTransformController {
  readonly #matcher: StentMatcher
  readonly #pending = new Map<string, number>()
  readonly #resolve: IdentityResolver

  public constructor(
    instrumentations: readonly StentInstrumentationConfig[],
    resolve: IdentityResolver,
  ) {
    this.#resolve = resolve
    this.#matcher = createStentMatcher(instrumentations, (patchId) => {
      this.#pending.set(
        patchId,
        (this.#pending.get(patchId) ?? NO_PENDING_BINDINGS) + BINDING_INCREMENT,
      )
    })
  }

  public transform(code: string, id: string): TransformOutput | null {
    return transformModuleState(code, id, {
      matcher: this.#matcher,
      pending: this.#pending,
      resolve: this.#resolve,
    })
  }
}

export { InstrumentedTransformController }
