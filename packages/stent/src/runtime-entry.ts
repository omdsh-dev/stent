import type { StentHandler, StentPatchInfo, StentTarget } from './types.ts'

function cloneTarget(target: StentTarget): StentTarget {
  let copy: StentTarget = { ...target }
  if (target.filePath instanceof RegExp) {
    copy = {
      ...copy,
      filePath: new RegExp(target.filePath.source, target.filePath.flags),
    }
  }
  if (target.filePaths !== undefined) {
    copy = { ...copy, filePaths: [...target.filePaths] }
  }
  if (target.functionQuery !== undefined) {
    copy = { ...copy, functionQuery: { ...target.functionQuery } }
  }
  return copy
}

function clonePatchInfo(info: StentPatchInfo): StentPatchInfo {
  const target = cloneTarget(info.target)
  if (info.bindings === undefined) {
    return { ...info, target }
  }
  const bindings = info.bindings.map((binding) => ({ ...binding }))
  return { ...info, target, bindings }
}

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
    this.#info = clonePatchInfo(info)
    this.#owner = owner
    this.#fiber = fiber
    this.#handler = handler
  }

  public get info(): StentPatchInfo {
    return clonePatchInfo(this.#info)
  }

  public snapshot(): StentPatchInfo {
    return clonePatchInfo(this.#info)
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

export { StentPatchEntry, clonePatchInfo }
