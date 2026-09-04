import type { PackageIdentity } from '#src/transform/identity'
import type { StentBinding } from '#src/types'

import type { LoaderBindingRecorder, LoaderState } from './types.ts'

const EMPTY_COUNT = 0

/**
 * Publish one state's pending node counts for a resolved package file.
 *
 * @param state - Installation state containing pending node counts.
 * @param identity - Package identity of the transformed file.
 * @param recordBindings - Callback that stores the binding records.
 * @returns Nothing; pending counts are cleared after they are published.
 */
function flushBindings(
  state: LoaderState,
  identity: PackageIdentity,
  recordBindings: LoaderBindingRecorder,
): void {
  if (state.pending.size === EMPTY_COUNT) {
    return
  }
  for (const [patchId, nodes] of state.pending) {
    const binding: StentBinding = {
      module: identity.name,
      file: identity.path,
      nodes,
    }
    recordBindings(patchId, [binding])
  }
  state.pending.clear()
}

export { flushBindings }
