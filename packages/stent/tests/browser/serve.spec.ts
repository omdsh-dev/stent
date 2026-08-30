import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { serveBrowserTransform } from '../../src/browser/index.ts'
import {
  boot,
  compositionPatch,
  createTestContext,
  createWorld,
  differentFilePatch,
  missing,
  neutralizer,
  planNeutralizer,
  provideTestWebServer,
  ROUTE,
  writeWorldPackage,
} from './serve-testkit.ts'

describe('serveBrowserTransform registration', () => {
  it('requires the composition base URL at registration', async () => {
    const ctx = createTestContext()
    await provideTestWebServer(ctx)
    expect(() => {
      serveBrowserTransform(ctx, { route: ROUTE, patches: [neutralizer] })
    }).toThrow(/requires ctx\.baseUrl/)
  })

  it('resolves a target package from the composition dependency tree', async () => {
    const { packageDir, configPath } = await createWorld()
    await writeWorldPackage(packageDir)
    const { port } = await boot(
      { route: ROUTE, patches: [compositionPatch()] },
      pathToFileURL(configPath).href,
    )
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('__stentBridge')
  })
})

describe('serveBrowserTransform exact routes', () => {
  it('serves the transformed bundle at the exact path', async () => {
    const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const body = await res.text()
    expect(body).toContain('__stentBridge')
    expect(body).toContain('bashToolviewSample')
  })

  it('leaves the source-map path to the fallback', async () => {
    const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}.map`)
    expect(res.status).toBe(404)
  })

  it('leaves every other /plugins path to the fallback', async () => {
    const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
    const res = await fetch(
      `http://127.0.0.1:${port}/plugins/@example/client-connection/client.js`,
    )
    expect(res.status).toBe(404)
  })

  it('the exact route outranks a later prefix route on the same path space', async () => {
    const { server, port } = await boot({
      route: ROUTE,
      patches: [neutralizer],
    })
    server.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        res.end('prefix-owner')
      },
    })
    const exact = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(await exact.text()).toContain('__stentBridge')
    const other = await fetch(
      `http://127.0.0.1:${port}/plugins/@example/client-connection/client.js`,
    )
    expect(await other.text()).toBe('prefix-owner')
  })

  it('rejects non-GET methods on the exact route', async () => {
    const { port } = await boot({ route: ROUTE, patches: [neutralizer] })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
      method: 'POST',
    })
    expect(res.status).toBe(405)
  })

  it('fails loud with a 500 when the selector rewrites nothing (default)', async () => {
    const { port } = await boot({ route: ROUTE, patches: [missing] })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('serve-test/missing')
  })
})

describe('serveBrowserTransform fallback and stacking', () => {
  it('serves the raw bundle when a miss degrades with fallback raw', async () => {
    const { port } = await boot({
      route: ROUTE,
      patches: [missing],
      fallback: 'raw',
    })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('__stentBridge')
    expect(body).toContain('bashToolviewSample')
  })

  it('answers 404 when the bundle file cannot be read', async () => {
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
    expect(res.status).toBe(404)
  })

  it('stacks several patches on the same file under one route', async () => {
    const { port } = await boot({
      route: ROUTE,
      patches: [neutralizer, planNeutralizer],
    })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('serve-test/neutralize-sample')
    expect(body).toContain('serve-test/neutralize-plan')
    expect(body).toContain('__stentBridge')
  })

  it('fails loud naming every unbound patch when only some stack', async () => {
    const { port } = await boot({
      route: ROUTE,
      patches: [neutralizer, missing],
    })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('serve-test/missing')
    expect(text).not.toContain('serve-test/neutralize-sample')
  })

  it('degrades to the raw bundle when any stacked patch misses with fallback raw', async () => {
    const { port } = await boot({
      route: ROUTE,
      patches: [neutralizer, missing],
      fallback: 'raw',
    })
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('__stentBridge')
  })
})

describe('serveBrowserTransform lifecycle', () => {
  it('rejects patches targeting different files at registration', async () => {
    const ctx = createTestContext(import.meta.url)
    await provideTestWebServer(ctx)
    expect(() => {
      serveBrowserTransform(ctx, {
        route: ROUTE,
        patches: [neutralizer, differentFilePatch()],
      })
    }).toThrow(/must all target the same file/)
  })

  it('disposing the owning fiber removes the route', async () => {
    const ctx = createTestContext(import.meta.url)
    const server = await provideTestWebServer(ctx)
    const routeFiber = await ctx.plugin((c) => {
      serveBrowserTransform(c, { route: ROUTE, patches: [neutralizer] })
    })
    const port = server.port
    expect((await fetch(`http://127.0.0.1:${port}${ROUTE}`)).status).toBe(200)
    await routeFiber.dispose()
    expect((await fetch(`http://127.0.0.1:${port}${ROUTE}`)).status).toBe(404)
  })
})
