import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import { serveBrowserTransform } from '#src/browser/index'
import type { ServeBrowserTransformOptions } from '#src/browser/serve'
import type { StentPatchStub } from '#src/types'

import { createTestWebServer } from './test-web-server.ts'

type TestWebServer = Awaited<ReturnType<typeof createTestWebServer>>

const FIRST_INDEX = 0

const contexts: Context[] = []
const servers: TestWebServer[] = []
const worlds: string[] = []

/** Fresh Cordis context, disposed by cleanupServeWorlds. */
function createTestContext(baseUrl?: string): Context {
  const ctx = new Context()
  if (baseUrl !== undefined) {
    ctx.baseUrl = baseUrl
  }
  contexts.push(ctx)
  return ctx
}

/** Seat a loopback web server on the context, closed by the same hook. */
async function provideTestWebServer(ctx: Context): Promise<TestWebServer> {
  const server = await createTestWebServer()
  servers.push(server)
  ctx.provide('webServer', server)
  return server
}

/** Mount the browser transform route over a fresh context and server. */
async function boot(
  options: ServeBrowserTransformOptions,
  baseUrl = import.meta.url,
): Promise<{ ctx: Context; server: TestWebServer; port: number }> {
  const ctx = createTestContext(baseUrl)
  const server = await provideTestWebServer(ctx)
  serveBrowserTransform(ctx, options)
  return { ctx, server, port: server.port }
}

/** Dispose every context, server and temp world the suite booted. */
async function cleanupServeWorlds(): Promise<void> {
  await Promise.all([
    ...contexts.splice(FIRST_INDEX).map(async (ctx) => {
      await ctx.fiber.dispose()
    }),
    ...servers.splice(FIRST_INDEX).map(async (server) => {
      await server.close()
    }),
    ...worlds.splice(FIRST_INDEX).map(async (world) => {
      await rm(world, { recursive: true, force: true })
    }),
  ])
}

/** Temp world holding a fake installed package and a cordis config. */
async function createWorld(): Promise<{
  world: string
  packageDir: string
  configPath: string
}> {
  const world = await mkdtemp(path.join(tmpdir(), 'stent-serve-world-'))
  worlds.push(world)
  const packageDir = path.join(
    world,
    'node_modules',
    '@fixture',
    'browser-target',
  )
  await mkdir(packageDir, { recursive: true })
  const configPath = path.join(world, 'cordis.yml')
  await writeFile(configPath, '')
  return { world, packageDir, configPath }
}

/** Write the fake package's manifest and browser bundle into the world. */
async function writeWorldPackage(packageDir: string): Promise<void> {
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@fixture/browser-target',
      version: '1.0.0',
      type: 'module',
    }),
  )
  await writeFile(
    path.join(packageDir, 'browser.js'),
    'const fixtureSample = { apply: function () { return "raw" } };\nexport { fixtureSample };\n',
  )
}

const ROUTE = '/plugins/@example/client-ui-conversation/client.js'

const serveTarget = {
  module: '@oh-my-dsh/stent',
  versionRange: '>=0.0.1-0',
  filePath: 'tests/fixtures/serve-target/browser.js',
} as const

const neutralizer = {
  id: 'serve-test/neutralize-sample',
  target: {
    ...serveTarget,
    astQuery:
      'VariableDeclarator[id.name="bashToolviewSample"] > ObjectExpression > Property[key.name="apply"] > FunctionExpression',
  },
  operation: 'around',
} as const

const missing = {
  id: 'serve-test/missing',
  target: {
    ...serveTarget,
    functionQuery: { functionName: 'noSuchFunction', kind: 'Sync' },
  },
  operation: 'before',
} as const

const planNeutralizer = {
  id: 'serve-test/neutralize-plan',
  target: {
    ...serveTarget,
    astQuery:
      'VariableDeclarator[id.name="planToolviewSample"] > ObjectExpression > Property[key.name="apply"] > FunctionExpression',
  },
  operation: 'around',
} as const

/** Patch anchored on the world package's own bundle. */
function compositionPatch(): StentPatchStub {
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

/** Patch pointing at a file the served bundle does not contain. */
function differentFilePatch(): StentPatchStub {
  return {
    ...neutralizer,
    id: 'serve-test/other-file',
    target: {
      ...neutralizer.target,
      filePath: 'tests/fixtures/serve-target/nope.js',
    },
  }
}

/** The HTTP statuses the served-bundle route answers with. */
const STATUS = {
  ok: 200,
  notFound: 404,
  methodNotAllowed: 405,
  internalError: 500,
}

export {
  cleanupServeWorlds,
  STATUS,
  createTestContext,
  provideTestWebServer,
  boot,
  createWorld,
  writeWorldPackage,
  ROUTE,
  neutralizer,
  missing,
  planNeutralizer,
  compositionPatch,
  differentFilePatch,
}
