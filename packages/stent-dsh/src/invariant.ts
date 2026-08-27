/**
 * Package-owned invariant companion for `@oh-my-dsh/stent-dsh`.
 * @module @oh-my-dsh/stent-dsh/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@oh-my-dsh/stent-dsh'

/** Cordis companion plugin name. */
export const name = 'stent-dsh-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * This package delegates invariant ownership to the authoritative DSH services;
 * its companion only reserves the package registration.
 */
const install: InvariantInstaller = () => {
  return undefined
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> => {
  return Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}
/* jscpd:ignore-end */
