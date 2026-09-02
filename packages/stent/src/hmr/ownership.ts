import type { Context } from '@deepseek-ai/cordis'

/**
 * Resolve the stable owner token for a Stent registration. Loader entry
 * identity survives HMR generations; the callback/runtime fallbacks keep the
 * same ownership semantics in unit tests and child processes.
 */
function registrationOwner(ctx: Context): unknown {
  const { fiber } = ctx
  if ('entry' in fiber && fiber.entry !== undefined) {
    return fiber.entry
  }
  return fiber.runtime?.callback ?? fiber
}

export { registrationOwner }
