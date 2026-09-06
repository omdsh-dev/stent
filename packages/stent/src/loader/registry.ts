import type { LoaderState } from './state.ts'

const NOT_FOUND_INDEX = -1
const REMOVE_COUNT = 1

/** Owns the process-wide set of active loader installations. */
class LoaderStateRegistry {
  readonly #states: LoaderState[] = []

  public list(): readonly LoaderState[] {
    return [...this.#states]
  }

  public add(state: LoaderState): void {
    this.#states.push(state)
  }

  public remove(state: LoaderState): void {
    const index = this.#states.indexOf(state)
    if (index !== NOT_FOUND_INDEX) {
      this.#states.splice(index, REMOVE_COUNT)
    }
  }

  public hasActive(): boolean {
    return this.#states.some((state) => state.active)
  }

  public clearSeen(filename: string): void {
    for (const state of this.#states) {
      state.clearSeen(filename)
    }
  }
}

const loaderStates = new LoaderStateRegistry()

export { loaderStates }
