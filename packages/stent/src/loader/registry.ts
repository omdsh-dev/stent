import type { LoaderState } from './state.ts'

/** Owns the process-wide set of active loader installations. */
class LoaderStateRegistry {
  readonly #states = new Set<LoaderState>()

  public list(): readonly LoaderState[] {
    return [...this.#states]
  }

  public add(state: LoaderState): void {
    this.#states.add(state)
  }

  public remove(state: LoaderState): void {
    this.#states.delete(state)
  }

  public hasActive(): boolean {
    for (const state of this.#states) {
      if (state.active) {
        return true
      }
    }
    return false
  }

  public clearSeen(filename: string): void {
    for (const state of this.#states) {
      state.clearSeen(filename)
    }
  }
}

const loaderStates = new LoaderStateRegistry()

export { loaderStates }
