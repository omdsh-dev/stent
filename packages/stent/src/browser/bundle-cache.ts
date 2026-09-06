/** Owns source-content caching for one transformed browser bundle route. */
class BundleCodeCache {
  #current: { source: string; code: string } | undefined
  readonly #readSource: () => string
  readonly #transform: (source: string) => string

  public constructor(
    readSource: () => string,
    transform: (source: string) => string,
  ) {
    this.#readSource = readSource
    this.#transform = transform
  }

  public clear(): void {
    this.#current = undefined
  }

  public read(): string {
    const source = this.#readSource()
    if (this.#current?.source === source) {
      return this.#current.code
    }
    const code = this.#transform(source)
    this.#current = { source, code }
    return code
  }
}

export { BundleCodeCache }
