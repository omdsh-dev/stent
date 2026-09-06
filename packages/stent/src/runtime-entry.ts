import type { StentHandler, StentPatchInfo } from './types.ts'

/** Owns mutable handler state and ownership identity for one registered patch. */
class StentPatchEntry {
  readonly #info: StentPatchInfo
  readonly #owner: unknown
  readonly #fiber: unknown
  #handler: StentHandler | undefined

  public constructor(
    info: StentPatchInfo,
    owner: unknown,
    fiber: unknown,
    handler: StentHandler | undefined,
  ) {
    this.#info = structuredClone(info)
    this.#owner = owner
    this.#fiber = fiber
    this.#handler = handler
  }

  public get info(): StentPatchInfo {
    return structuredClone(this.#info)
  }

  public snapshot(): StentPatchInfo {
    return structuredClone(this.#info)
  }

  public get owner(): unknown {
    return this.#owner
  }

  public get fiber(): unknown {
    return this.#fiber
  }

  public get handler(): StentHandler | undefined {
    return this.#handler
  }

  public enable(handler: StentHandler): void {
    this.#handler = handler
  }

  public disable(): void {
    this.#handler = undefined
  }

  public isOwnedBy(fiber: unknown): boolean {
    return this.#fiber === fiber
  }

  public isEnabled(): boolean {
    return this.#handler !== undefined
  }
}

export { StentPatchEntry }
