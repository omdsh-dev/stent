/**
 * Process-local activation marker for the DSH Stent launch path.
 *
 * Installing Stent hooks is a lower-level operation that can also be used by
 * standalone callers. DSH-facing plugins use this marker as the policy gate:
 * only the `stent-dsh` preload (or the browser Stent entry) may activate them.
 */

/** Shared global identity so profile-resolved copies see the same marker. */
const STENT_DSH_LAUNCH_KEY = Symbol.for('oh-my-dsh.stent-dsh.launch')

/**
 * Mark the current global object as being in the Stent-enabled DSH launch path.
 *
 * @param globalObject - Global-like object used by the runtime or a test.
 */
function markStentDshLaunch(globalObject: object = globalThis): void {
  if (isStentDshLaunch(globalObject)) {
    return
  }
  Object.defineProperty(globalObject, STENT_DSH_LAUNCH_KEY, {
    configurable: true,
    enumerable: false,
    value: true,
    writable: false,
  })
}

/**
 * Check whether the current process or browser runtime was activated through
 * the Stent DSH entrypoint.
 *
 * This is a lifecycle policy marker, not a security boundary. It deliberately
 * differs from `isStentInstalled()`: a caller may install low-level hooks for
 * standalone use without granting DSH plugins the Stent launch capability.
 *
 * @param globalObject - Global-like object used by the runtime or a test.
 * @returns Whether the Stent DSH launch marker is present.
 */
function isStentDshLaunch(globalObject: object = globalThis): boolean {
  return (
    (globalObject as Record<PropertyKey, unknown>)[STENT_DSH_LAUNCH_KEY]
    === true
  )
}

export { STENT_DSH_LAUNCH_KEY, markStentDshLaunch, isStentDshLaunch }
