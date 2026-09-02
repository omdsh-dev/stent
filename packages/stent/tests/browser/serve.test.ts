import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { serveBrowserTransform } from '#src/browser/index'

import {
  ROUTE,
  STATUS,
  boot,
  cleanupServeWorlds,
  compositionPatch,
  createTestContext,
  createWorld,
  differentFilePatch,
  missing,
  neutralizer,
  planNeutralizer,
  provideTestWebServer,
  writeWorldPackage,
} from './serve-testkit.ts'

describe('serveBrowserTransform registration', () => {
  afterEach(cleanupServeWorlds)

  it(
    'requires the composition base URL at registration',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = createTestContext()
      await provideTestWebServer(ctx)
      expect(() => {
        serveBrowserTransform(ctx, { route: ROUTE, patches: [neutralizer] })
      }).toThrow(/requires ctx\.baseUrl/u)
    },
  )

  it(
    'resolves a target package from the composition dependency tree',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { packageDir, configPath } = await createWorld()
      await writeWorldPackage(packageDir)
      const { port } = await boot(
        { route: ROUTE, patches: [compositionPatch()] },
        pathToFileURL(configPath).href,
      )
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.ok)
      await expect(res.text()).resolves.toContain('__stentBridge')
    },
  )
})

describe('serveBrowserTransform exact routes', () => {
  afterEach(cleanupServeWorlds)

  it(
    'serves the transformed bundle at the exact path',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.ok)
      expect(res.headers.get('content-type')).toContain('text/javascript')
      const body = await res.text()
      expect(body).toContain('__stentBridge')
      expect(body).toContain('bashToolviewSample')
    },
  )

  it(
    'leaves the source-map path to the fallback',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}.map`)
      expect(res.status).toBe(STATUS.notFound)
    },
  )

  it(
    'leaves every other /plugins path to the fallback',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
      const res = await fetch(
        `http://127.0.0.1:${port}/plugins/@example/client-connection/client.js`,
      )
      expect(res.status).toBe(STATUS.notFound)
    },
  )
})

describe('serveBrowserTransform exact route semantics', () => {
  afterEach(cleanupServeWorlds)

  it(
    'the exact route outranks a later prefix route on the same path space',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { server, port } = await boot({
        route: ROUTE,
        patches: [neutralizer],
      })
      server.register({
        kind: 'prefix',
        path: '/plugins',
        handler: (_req, res) => {
          res.writeHead(STATUS.ok, {
            'content-type': 'text/javascript; charset=utf-8',
          })
          res.end('prefix-owner')
        },
      })
      const exact = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      await expect(exact.text()).resolves.toContain('__stentBridge')
      const other = await fetch(
        `http://127.0.0.1:${port}/plugins/@example/client-connection/client.js`,
      )
      await expect(other.text()).resolves.toBe('prefix-owner')
    },
  )

  it(
    'rejects non-GET methods on the exact route',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
        method: 'POST',
      })
      expect(res.status).toBe(STATUS.methodNotAllowed)
    },
  )
})

describe('serveBrowserTransform failure modes', () => {
  afterEach(cleanupServeWorlds)

  it(
    'fails loud with a 500 when the selector rewrites nothing (default)',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({ route: ROUTE, patches: [missing] })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.internalError)
      await expect(res.text()).resolves.toContain('serve-test/missing')
    },
  )

  it(
    'answers 404 when the bundle file cannot be read',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({
        route: ROUTE,
        patches: [
          {
            ...neutralizer,
            target: {
              ...neutralizer.target,
              filePath: 'tests/fixtures/serve-target/nope.js',
            },
          },
        ],
      })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.notFound)
    },
  )
})

describe('serveBrowserTransform fallback', () => {
  afterEach(cleanupServeWorlds)

  it(
    'serves the raw bundle when a miss degrades with fallback raw',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({
        route: ROUTE,
        patches: [missing],
        fallback: 'raw',
      })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.ok)
      const body = await res.text()
      expect(body).not.toContain('__stentBridge')
      expect(body).toContain('bashToolviewSample')
    },
  )

  it(
    'degrades to the raw bundle when any stacked patch misses with fallback raw',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({
        route: ROUTE,
        patches: [neutralizer, missing],
        fallback: 'raw',
      })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.ok)
      const body = await res.text()
      expect(body).not.toContain('__stentBridge')
    },
  )
})

describe('serveBrowserTransform stacking', () => {
  afterEach(cleanupServeWorlds)

  it(
    'stacks several patches on the same file under one route',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({
        route: ROUTE,
        patches: [neutralizer, planNeutralizer],
      })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.ok)
      const body = await res.text()
      expect(body).toContain('serve-test/neutralize-sample')
      expect(body).toContain('serve-test/neutralize-plan')
      expect(body).toContain('__stentBridge')
    },
  )

  it(
    'fails loud naming every unbound patch when only some stack',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const { port } = await boot({
        route: ROUTE,
        patches: [neutralizer, missing],
      })
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(res.status).toBe(STATUS.internalError)
      const text = await res.text()
      expect(text).toContain('serve-test/missing')
      expect(text).not.toContain('serve-test/neutralize-sample')
    },
  )
})

describe('serveBrowserTransform lifecycle', () => {
  afterEach(cleanupServeWorlds)

  it(
    'rejects patches targeting different files at registration',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = createTestContext(import.meta.url)
      await provideTestWebServer(ctx)
      expect(() => {
        serveBrowserTransform(ctx, {
          route: ROUTE,
          patches: [neutralizer, differentFilePatch()],
        })
      }).toThrow(/must all target the same file/u)
    },
  )

  it(
    'disposing the owning fiber removes the route',
    { timeout: 5000 },
    async () => {
      expect.hasAssertions()
      const ctx = createTestContext(import.meta.url)
      const server = await provideTestWebServer(ctx)
      const routeFiber = await ctx.plugin((owner) => {
        serveBrowserTransform(owner, { route: ROUTE, patches: [neutralizer] })
      })
      const { port } = server
      const beforeDispose = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(beforeDispose.status).toBe(STATUS.ok)
      await routeFiber.dispose()
      const afterDispose = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
      expect(afterDispose.status).toBe(STATUS.notFound)
    },
  )
})
