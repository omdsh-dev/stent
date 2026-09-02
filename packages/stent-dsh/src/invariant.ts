/**
 * Package-owned invariant companion for `@oh-my-dsh/stent-dsh`.
 *
 * @module @oh-my-dsh/stent-dsh/invariant
 */

/* Duplication scanner directive: jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@oh-my-dsh/stent-dsh'

/** Cordis companion plugin name. */
const name = 'stent-dsh-invariant'
/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/**
 * This package delegates invariant ownership to the authoritative DSH services;
 * its companion only reserves the package registration. The registration
 * disposer is returned directly so Cordis collects it as the fiber effect.
 */
const apply = (ctx: Readonly<Context>): (() => void) =>
  ctx.invariants.register(PACKAGE_NAME, ((): void => {
    /* No invariant contribution: ownership is delegated to the authoritative DSH services. */
  }) satisfies InvariantInstaller)

export { name, inject, apply }
/* Duplication scanner directive: jscpd:ignore-end */
