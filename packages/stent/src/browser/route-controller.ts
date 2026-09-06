import type { IncomingMessage, ServerResponse } from 'node:http'

/** Owns exact web-route registration and its disposer lifecycle. */
interface ExactRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void
}

interface WebServerService {
  readonly register: (route: ExactRoute) => () => void
}

class ExactRouteController {
  readonly #server: WebServerService
  readonly #route: ExactRoute
  #remove: (() => void) | undefined
  readonly #onDispose: (() => void) | undefined

  public constructor(
    server: WebServerService,
    route: ExactRoute,
    onDispose?: () => void,
  ) {
    this.#server = server
    this.#route = route
    this.#onDispose = onDispose
  }

  public install(): void {
    if (this.#remove !== undefined) {
      return
    }
    this.#remove = this.#server.register(this.#route)
  }

  public dispose(): void {
    const remove = this.#remove
    if (remove === undefined) {
      return
    }
    this.#remove = undefined
    remove()
    this.#onDispose?.()
  }
}

export { ExactRouteController }
export type { ExactRoute, WebServerService }
