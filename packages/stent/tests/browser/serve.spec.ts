// The serveBrowserTransform primitive: boots a test HTTP server and proves
// the exact route outranks the module host's prefix table, serves the
// transformed fixture bundle (bridge marker present), leaves every other
// path to the fallback or a prefix route, rejects non-GET methods, and is
// loud by default when the selector rewrites nothing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { serveBrowserTransform, type ServeBrowserTransformOptions } from '../../src/index.ts'

type TestRoute = {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface TestWebServer {
  port: number
  register(route: TestRoute): () => void
  close: () => Promise<void>
}

const contexts: Context[] = []
const servers: TestWebServer[] = []
const worlds: string[] = []

/** Boot the minimal HTTP server contract consumed by serveBrowserTransform. */
async function createTestWebServer(): Promise<TestWebServer> {
  const exact = new Map<string, TestRoute>()
  const prefixes = new Map<string, TestRoute>()
  const match = (pathname: string): TestRoute | undefined => {
    const exactRoute = exact.get(pathname)
    if (exactRoute !== undefined) return exactRoute
    let best: TestRoute | undefined
    for (const [prefix, route] of prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }
  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = match(new URL(req.url ?? '/', 'http://test').pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    await route.handler(req, res)
  }
  const httpServer: Server = createServer((req, res) => {
    dispatch(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(500)
      res.end(String(error instanceof Error ? error.message : error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('test webserver did not expose a TCP address')
  return {
    port: address.port,
    register(route) {
      const routes = route.kind === 'exact' ? exact : prefixes
      if (routes.has(route.path)) throw new Error(`test webserver: duplicate ${route.kind} route "${route.path}"`)
      routes.set(route.path, route)
      return () => {
        if (routes.get(route.path) === route) routes.delete(route.path)
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error === undefined) resolve()
          else reject(error)
        })
      }),
  }
}

async function provideTestWebServer(ctx: Context): Promise<TestWebServer> {
  const server = await createTestWebServer()
  servers.push(server)
  ctx.provide('webServer', server as never)
  return server
}

/** Boot a test HTTP server plus one served transform. */
async function boot(options: ServeBrowserTransformOptions, baseUrl = import.meta.url) {
  const ctx = new Context()
  ctx.baseUrl = baseUrl
  contexts.push(ctx)
  const server = await provideTestWebServer(ctx)
  serveBrowserTransform(ctx, options)
  return { ctx, server, port: server.port }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
  for (const server of servers.splice(0)) {
    await server.close()
  }
  for (const world of worlds.splice(0)) {
    await rm(world, { recursive: true, force: true })
  }
})

/** The exact route the fixture bundle is served under. */
const ROUTE = '/plugins/@example/client-ui-conversation/client.js'

/** The neutralizer patch: rewrites the fixture's bashToolviewSample.apply. */
const neutralizer = {
  id: 'serve-test/neutralize-sample',
  target: {
    module: '@oh-my-dsh/stent',
    versionRange: '>=0.0.1-0',
    filePath: 'tests/fixtures/serve-target/browser.js',
    astQuery:
      'VariableDeclarator[id.name="bashToolviewSample"] > ObjectExpression > Property[key.name="apply"] > FunctionExpression',
  },
  operation: 'around',
} as const

/** A patch whose selector cannot match anything in the fixture. */
const missing = {
  id: 'serve-test/missing',
  target: {
    module: '@oh-my-dsh/stent',
    versionRange: '>=0.0.1-0',
    filePath: 'tests/fixtures/serve-target/browser.js',
    functionQuery: { functionName: 'noSuchFunction', kind: 'Sync' },
  },
  operation: 'before',
} as const

/** A second patch on the SAME file (the plan sample), for the multi-patch cases. */
const planNeutralizer = {
  id: 'serve-test/neutralize-plan',
  target: {
    module: '@oh-my-dsh/stent',
    versionRange: '>=0.0.1-0',
    filePath: 'tests/fixtures/serve-target/browser.js',
    astQuery:
      'VariableDeclarator[id.name="planToolviewSample"] > ObjectExpression > Property[key.name="apply"] > FunctionExpression',
  },
  operation: 'around',
} as const

describe('serveBrowserTransform', () => {
  it('requires the composition base URL at registration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await provideTestWebServer(ctx)
    expect(() => {
      serveBrowserTransform(ctx, { route: ROUTE, patch: neutralizer })
    }).toThrow(/requires ctx\.baseUrl/)
  })

  it('resolves a target package from the composition dependency tree', async () => {
    const world = await mkdtemp(join(tmpdir(), 'stent-serve-world-'))
    worlds.push(world)
    const packageDir = join(world, 'node_modules', '@fixture', 'browser-target')
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/browser-target',
        version: '1.0.0',
        type: 'module',
      }),
    )
    await writeFile(
      join(packageDir, 'browser.js'),
      'const fixtureSample = { apply: function () { return "raw" } };\nexport { fixtureSample };\n',
    )
    const configPath = join(world, 'cordis.yml')
    await writeFile(configPath, '')
    const patch = {
      id: 'serve-test/composition-anchor',
      target: {
        module: '@fixture/browser-target',
        versionRange: '>=0.0.1-0',
        filePath: 'browser.js',
        astQuery:
          'VariableDeclarator[id.name="fixtureSample"] > ObjectExpression > Property[key.name="apply"] > FunctionExpression',
      },
      operation: 'around',
    } as const
    const { port } = await boot({ route: ROUTE, patch }, pathToFileURL(configPath).href)
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('__stentBridge')
  })

  it('serves the transformed bundle at the exact path', async () => {
    const { port } = await boot({ route: ROUTE, patch: neutralizer })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const body = await res.text()
    // The sample's apply was rewritten into a bridge call: the served bytes
    // carry the stent bridge handle, and the sample name is preserved.
    expect(body).toContain('__stentBridge')
    expect(body).toContain('bashToolviewSample')
  })

  it('leaves the source-map path to the fallback', async () => {
    const { port } = await boot({ route: ROUTE, patch: neutralizer })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}.map`)
    // No fallback seat in this harness: 404 — the point is the primitive
    // claims ONLY the exact bundle path.
    expect(res.status).toBe(404)
  })

  it('leaves every other /plugins path to the fallback', async () => {
    const { port } = await boot({ route: ROUTE, patch: neutralizer })
    const res = await fetch(`http://127.0.0.1:${port}/plugins/@example/client-connection/client.js`)
    expect(res.status).toBe(404)
  })

  it('the exact route outranks a later prefix route on the same path space', async () => {
    const { server, port } = await boot({ route: ROUTE, patch: neutralizer })
    // A prefix route registered AFTER the exact one (the module host's shape).
    server.register({
      kind: 'prefix',
      path: '/plugins',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        res.end('prefix-owner')
      },
    })
    const exact = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(await exact.text()).toContain('__stentBridge')
    const other = await fetch(`http://127.0.0.1:${port}/plugins/@example/client-connection/client.js`)
    expect(await other.text()).toBe('prefix-owner')
  })

  it('rejects non-GET methods on the exact route', async () => {
    const { port } = await boot({ route: ROUTE, patch: neutralizer })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('fails loud with a 500 when the selector rewrites nothing (default)', async () => {
    const { port } = await boot({ route: ROUTE, patch: missing })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('serve-test/missing')
  })

  it('serves the raw bundle when a miss degrades with fallback raw', async () => {
    const { port } = await boot({ route: ROUTE, patch: missing, fallback: 'raw' })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    // Untouched: no bridge marker, no rewritten apply.
    expect(body).not.toContain('__stentBridge')
    expect(body).toContain('bashToolviewSample')
  })

  it('answers 404 when the bundle file cannot be read', async () => {
    const { port } = await boot({
      route: ROUTE,
      patch: { ...neutralizer, target: { ...neutralizer.target, filePath: 'tests/fixtures/serve-target/nope.js' } },
    })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(404)
  })

  it('stacks several patches on the same file under one route', async () => {
    const { port } = await boot({ route: ROUTE, patch: [neutralizer, planNeutralizer] })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    // Both rewrites landed: each patch id names its emitted bridge channel.
    expect(body).toContain('serve-test/neutralize-sample')
    expect(body).toContain('serve-test/neutralize-plan')
    expect(body).toContain('__stentBridge')
  })

  it('fails loud naming every unbound patch when only some stack', async () => {
    const { port } = await boot({ route: ROUTE, patch: [neutralizer, missing] })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('serve-test/missing')
    expect(text).not.toContain('serve-test/neutralize-sample')
  })

  it('degrades to the raw bundle when any stacked patch misses with fallback raw', async () => {
    const { port } = await boot({ route: ROUTE, patch: [neutralizer, missing], fallback: 'raw' })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    // Untouched: no bridge marker, no rewritten apply.
    expect(body).not.toContain('__stentBridge')
  })

  it('rejects patches targeting different files at registration', async () => {
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    contexts.push(ctx)
    await provideTestWebServer(ctx)
    expect(() => {
      serveBrowserTransform(ctx, {
        route: ROUTE,
        patch: [
          neutralizer,
          {
            ...neutralizer,
            id: 'serve-test/other-file',
            target: { ...neutralizer.target, filePath: 'tests/fixtures/serve-target/nope.js' },
          },
        ],
      })
    }).toThrow(/must all target the same file/)
  })

  it('disposing the owning fiber removes the route', async () => {
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    contexts.push(ctx)
    const server = await provideTestWebServer(ctx)
    // The route owner lives on its own plugin fiber, so disposing it removes
    // the route while the webserver keeps serving.
    const routeFiber = await ctx.plugin(c => {
      serveBrowserTransform(c, { route: ROUTE, patch: neutralizer })
    })
    const port = server.port
    expect((await fetch(`http://127.0.0.1:${port}${ROUTE}`)).status).toBe(200)
    await routeFiber.dispose()
    expect((await fetch(`http://127.0.0.1:${port}${ROUTE}`)).status).toBe(404)
  })
})
