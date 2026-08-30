import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach } from 'vitest'

import {
  serveBrowserTransform,
  type ServeBrowserTransformOptions,
} from '../../src/browser/index.ts'

type TestRoute = {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface TestWebServer {
  port: number
  register(route: TestRoute): () => void
  close: () => Promise<void>
}

const contexts: Context[] = []
const servers: TestWebServer[] = []
const worlds: string[] = []

async function createTestWebServer(): Promise<TestWebServer> {
  const exact = new Map<string, TestRoute>()
  const prefixes = new Map<string, TestRoute>()
  const match = (pathname: string): TestRoute | undefined => {
    const exactRoute = exact.get(pathname)
    if (exactRoute !== undefined) {
      return exactRoute
    }
    let best: TestRoute | undefined
    for (const [prefix, route] of prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
        continue
      }
      if (best === undefined || prefix.length > best.path.length) {
        best = route
      }
    }
    return best
  }
  const dispatch = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
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
  if (address === null || typeof address === 'string') {
    throw new Error('test webserver did not expose a TCP address')
  }
  return {
    port: address.port,
    register(route) {
      const routes = route.kind === 'exact' ? exact : prefixes
      if (routes.has(route.path)) {
        throw new Error(
          `test webserver: duplicate ${route.kind} route "${route.path}"`,
        )
      }
      routes.set(route.path, route)
      return () => {
        if (routes.get(route.path) === route) {
          routes.delete(route.path)
        }
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      }),
  }
}

export function createTestContext(baseUrl?: string): Context {
  const ctx = new Context()
  if (baseUrl !== undefined) {
    ctx.baseUrl = baseUrl
  }
  contexts.push(ctx)
  return ctx
}

export async function provideTestWebServer(
  ctx: Context,
): Promise<TestWebServer> {
  const server = await createTestWebServer()
  servers.push(server)
  ctx.provide('webServer', server as never)
  return server
}

export async function boot(
  options: ServeBrowserTransformOptions,
  baseUrl = import.meta.url,
): Promise<{ ctx: Context; server: TestWebServer; port: number }> {
  const ctx = createTestContext(baseUrl)
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

export async function createWorld(): Promise<{
  world: string
  packageDir: string
  configPath: string
}> {
  const world = await mkdtemp(join(tmpdir(), 'stent-serve-world-'))
  worlds.push(world)
  const packageDir = join(world, 'node_modules', '@fixture', 'browser-target')
  await mkdir(packageDir, { recursive: true })
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, '')
  return { world, packageDir, configPath }
}

export async function writeWorldPackage(packageDir: string): Promise<void> {
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
}

export const ROUTE = '/plugins/@example/client-ui-conversation/client.js'

export const neutralizer = {
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

export const missing = {
  id: 'serve-test/missing',
  target: {
    module: '@oh-my-dsh/stent',
    versionRange: '>=0.0.1-0',
    filePath: 'tests/fixtures/serve-target/browser.js',
    functionQuery: { functionName: 'noSuchFunction', kind: 'Sync' },
  },
  operation: 'before',
} as const

export const planNeutralizer = {
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

export function compositionPatch() {
  return {
    id: 'serve-test/composition-anchor',
    target: {
      module: '@fixture/browser-target',
      versionRange: '>=0.0.1-0',
      filePath: 'browser.js',
      astQuery:
        'VariableDeclarator[id.name="fixtureSample"] > ObjectExpression > Property[key.name="apply"] > FunctionExpression',
    },
    operation: 'around' as const,
  }
}

export function differentFilePatch() {
  return {
    ...neutralizer,
    id: 'serve-test/other-file',
    target: {
      ...neutralizer.target,
      filePath: 'tests/fixtures/serve-target/nope.js',
    },
  }
}
