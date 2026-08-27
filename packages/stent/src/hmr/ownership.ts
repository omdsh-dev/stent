import type { Context } from '@deepseek-ai/cordis'

/**
 * Resolve the stable owner token for a Stent registration. Loader entry
 * identity survives HMR generations; the callback/runtime fallbacks keep the
 * same ownership semantics in unit tests and child processes.
 */
export function registrationOwner(ctx: Context): unknown {
  const entry = (ctx.fiber as { entry?: unknown }).entry
  if (entry !== undefined) {
    return entry
  }
  const runtime = ctx.fiber.runtime
  return runtime?.callback ?? ctx.fiber
}
