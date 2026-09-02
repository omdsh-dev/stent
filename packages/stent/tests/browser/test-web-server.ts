import { once } from 'node:events'
import { createServer } from 'node:http'

interface TestRequestLike {
  readonly url?: string | undefined
}

interface TestResponseLike {
  readonly headersSent: boolean
  readonly destroy: () => void
  readonly end: (chunk?: string) => void
  readonly writeHead: (
    statusCode: number,
    headers?: Record<string, string>,
  ) => void
}

interface TestRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (
    req: TestRequestLike,
    res: TestResponseLike,
  ) => void | Promise<void>
}

interface TestWebServer {
  readonly port: number
  readonly register: (route: TestRoute) => () => void
  readonly close: () => Promise<void>
}

const STATUS_NOT_FOUND = 404
const STATUS_INTERNAL_ERROR = 500
const ANY_PORT = 0

/** Longest prefix route matching the request path. */
function selectPrefixRoute(
  prefixes: Map<string, TestRoute>,
  pathname: string,
): TestRoute | undefined {
  let best: TestRoute | undefined = undefined
  for (const [prefix, route] of prefixes) {
    if (
      (pathname === prefix || pathname.startsWith(`${prefix}/`))
      && (best === undefined || prefix.length > best.path.length)
    ) {
      best = route
    }
  }
  return best
}

/** Route for one request URL: exact match first, then longest prefix. */
function matchRoute(
  url: string | undefined,
  exact: Map<string, TestRoute>,
  prefixes: Map<string, TestRoute>,
): TestRoute | undefined {
  const { pathname } = new URL(url ?? '/', 'http://test')
  const exactRoute = exact.get(pathname)
  if (exactRoute !== undefined) {
    return exactRoute
  }
  return selectPrefixRoute(prefixes, pathname)
}

/** Registrar that adds one route and returns its remover. */
function createRouteRegistrar(
  exact: Map<string, TestRoute>,
  prefixes: Map<string, TestRoute>,
): (route: TestRoute) => () => void {
  const tables = {
    exact,
    prefix: prefixes,
  }
  return (route) => {
    const table = tables[route.kind]
    if (table.has(route.path)) {
      throw new Error(
        `test webserver: duplicate ${route.kind} route "${route.path}"`,
      )
    }
    table.set(route.path, route)
    return () => {
      if (table.get(route.path) === route) {
        table.delete(route.path)
      }
    }
  }
}

/** Answer a failed dispatch without leaking the error to the socket. */
function handleServerError(res: TestResponseLike, error: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(STATUS_INTERNAL_ERROR)
  if (error instanceof Error) {
    res.end(error.message)
  } else {
    res.end(String(error))
  }
}

/** Bind the server to an ephemeral loopback port. */
async function listenOnRandomPort(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  const listening = once(server, 'listening')
  server.listen(ANY_PORT, '127.0.0.1')
  await listening
}

/** Close the server and wait for its close event. */
async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  server.close()
  await once(server, 'close')
}

/** Start a loopback web server the serve suites register routes on. */
async function createTestWebServer(): Promise<TestWebServer> {
  const exact = new Map<string, TestRoute>()
  const prefixes = new Map<string, TestRoute>()
  const dispatch = async (
    req: TestRequestLike,
    res: TestResponseLike,
  ): Promise<void> => {
    try {
      const route = matchRoute(req.url, exact, prefixes)
      if (route === undefined) {
        res.writeHead(STATUS_NOT_FOUND)
        res.end()
        return
      }
      await route.handler(req, res)
    } catch (error: unknown) {
      handleServerError(res, error)
    }
  }
  /* The node:http listener cannot await, so each dispatch is kept here and
     drained on close: no request is cut off mid-write by server.close(). */
  const inFlight: Promise<void>[] = []
  const httpServer: ReturnType<typeof createServer> = createServer(
    (req, res) => {
      inFlight.push(dispatch(req, res))
    },
  )
  await listenOnRandomPort(httpServer)
  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test webserver did not expose a TCP address')
  }
  return {
    port: address.port,
    register: createRouteRegistrar(exact, prefixes),
    close: async (): Promise<void> => {
      await Promise.all(inFlight)
      await closeServer(httpServer)
    },
  }
}

export { createTestWebServer }
