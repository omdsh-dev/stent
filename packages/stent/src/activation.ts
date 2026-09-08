/**
 * Process-local activation marker for the DSH Stent launch path.
 *
 * Installing Stent hooks is a lower-level operation that can also be used by
 * standalone callers. DSH-facing plugins use this marker as the policy gate:
 * the imported `stent-loader` (or browser Stent entry) activates them.
 */

/** Shared global identity so profile-resolved copies see the same marker. */
const STENT_ACTIVATION_KEY = Symbol.for('oh-my-dsh.stent.activation')

/**
 * Check whether the current process or browser runtime was activated through a
 * Stent activation entrypoint.
 *
 * This is a lifecycle policy marker, not a security boundary. It deliberately
 * differs from `isStentInstalled()`: a caller may install low-level hooks for
 * standalone use without granting DSH plugins the Stent launch capability.
 *
 * @param globalObject - Global-like object used by the runtime or a test.
 * @returns Whether Stent activation is present in this runtime.
 */
function isStentActive(globalObject: object = globalThis): boolean {
  if (!(STENT_ACTIVATION_KEY in globalObject)) {
    return false
  }
  return globalObject[STENT_ACTIVATION_KEY] === true
}

/**
 * Mark the current global object as being in the Stent-enabled DSH launch path.
 *
 * @param globalObject - Global-like object used by the runtime or a test.
 */
function activateStent(globalObject: object = globalThis): void {
  if (isStentActive(globalObject)) {
    return
  }
  Object.defineProperty(globalObject, STENT_ACTIVATION_KEY, {
    configurable: true,
    enumerable: false,
    value: true,
    writable: false,
  })
}

export { STENT_ACTIVATION_KEY, activateStent, isStentActive }
