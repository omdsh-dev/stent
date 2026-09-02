import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
// @vitest-environment happy-dom
import type {
  CommandContribution,
  SelectOption,
} from '@deepseek-ai/dsh-client-ui-commands/client'
import { beforeAll, describe, expect, it } from 'vitest'

import { StentClientService, apply } from '#src/browser/client/index'

import {
  isCommandUiModule,
  isSlotRegistryModule,
  materializeAs,
  prepareClientBundles,
  seedMap,
} from './module-loader.ts'

const PLATFORM_SEEDS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  'react',
  'react/jsx-runtime',
]
const REGISTRY_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-client-ui-commands/client',
  '@deepseek-ai/dsh-client-runtime/client',
]
const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/fixtures/node_modules/stent-client-fixture-mod/index.mjs',
)

/** Stub directory: the popup shell is never opened in this test. */
async function emptySelectOptions(): Promise<readonly SelectOption[]> {
  const options: readonly SelectOption[] = []
  await Promise.resolve()
  return options
}

/** Register the callable faces the browser registries require. */
function provideClientFaces(ctx: Context): void {
  ctx.provide('inputTriggers', {
    registerSource: (): (() => void) => () => {
      /* Nothing to release */
    },
  })
  ctx.provide('sessions', {
    scope: (): void => {
      /* Nothing to scope */
    },
    scopeOf: (): void => {
      /* Nothing to scope */
    },
  })
  const commandsRemote = { list: emptySelectOptions }
  /* CommandUiRuntime injects `remote` for the forwarded directory invalidation. */
  ctx.provide('remote', {
    commands: commandsRemote,
    $on: (): (() => void) => () => {
      /* Nothing to release */
    },
  })
  ctx.provide('remote.commands', commandsRemote)
}

/** Mount the real browser registries and the Stent client facade. */
async function mountClientRegistries(ctx: Context): Promise<void> {
  const { CommandUiRuntime: commandUiRuntime } = materializeAs(
    '@deepseek-ai/dsh-client-ui-commands',
    isCommandUiModule,
  )
  const { SlotRegistry: slotRegistry } = materializeAs(
    '@deepseek-ai/dsh-client-runtime',
    isSlotRegistryModule,
  )
  await ctx.plugin(slotRegistry).await()
  await ctx.plugin(commandUiRuntime).await()
  await apply(ctx)
}

/** Read the mounted client service (apply throws when it is missing). */
function getStentClient(ctx: Context): StentClientService {
  const client = ctx.get('stentClient')
  if (!(client instanceof StentClientService)) {
    throw new Error('stent-dsh: browser client service missing in fixture')
  }
  return client
}

/** An inert slot value: the shell is never rendered in this test. */
const stubComponent = {}

const sameCommand = (): CommandContribution => ({
  name: 'modclientcmd',
  description: 'fixture client command',
  available: (): boolean => true,
  ui: {
    kind: 'popupSelect',
    options: emptySelectOptions,
    onSelect: (): void => {
      /* Nothing to release */
    },
  },
})

/**
 * Browser assembly: the real browser command and slot services (the `stent-dsh`
 * client row's `ctx.command`/`ctx.slots` delegates) over fake
 * slash/sessions/connection faces, plus the real Loader booting an unmodified
 * browser fixture Mod through `ctx.stentClient`. This mirrors the web-roster
 * composition with the opt-in row enabled.
 */
/* Cordis hands back a value-returning disposer; callers get a plain
   "stop listening" call instead. */
function recordSlotChanges(ctx: Context, changed: string[]): () => void {
  const stopListening = ctx.on('slots/changed', (key: string): void => {
    changed.push(key)
  })
  return (): void => {
    stopListening()
  }
}

async function assemble(): Promise<{
  ctx: Context
  id: string
  changed: string[]
  listen: () => void
}> {
  const ctx = new Context()
  /* The Loader resolves entries against ctx.baseUrl; under happy-dom the
     environment location is http://localhost:3000, so pin the base (and the
     fixture url below) to real file paths from the package root. */
  ctx.baseUrl = path.join(process.cwd(), 'tests')
  provideClientFaces(ctx)
  await mountClientRegistries(ctx)
  const changed: string[] = []
  const listen = recordSlotChanges(ctx, changed)
  await ctx.plugin(Loader)
  const id = await ctx.loader.create({
    name: pathToFileURL(FIXTURE_PATH).href,
  })
  await ctx.loader.await()
  return { ctx, id, changed, listen }
}

describe('stent API browser assembly', () => {
  beforeAll(async () => {
    /* Ui-primitives is a heavy render-only package (markdown/highlighting);
       the command service only touches it on render paths, so stub it in the
       module table instead of pulling its dependency tree into tests. */
    seedMap({ '@deepseek-ai/dsh-client-ui-primitives': {} })
    await prepareClientBundles(PLATFORM_SEEDS, REGISTRY_BUNDLES)
  })

  it(
    'boots a browser fixture Mod whose contributions reach the real client services',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx, changed, listen } = await assemble()
      const client = getStentClient(ctx)

      /* The client command contribution lives in the authoritative command
       service: a duplicate registration fails loud while it is live. */
      expect(() => client.registerCommand(sameCommand())).toThrow(
        /duplicate contribution/u,
      )

      /* The slot contribution reached the real slot registry: the single
       'root' hole is occupied, and the registration emitted slots/changed. */
      expect(() =>
        client.registerSlot({ name: 'root' }, stubComponent),
      ).toThrow(/single/u)
      expect(changed).toContain('root')
      listen()

      await ctx.fiber.dispose()
    },
  )
})

describe('stent API browser assembly: HMR safety', () => {
  it(
    'removes both contributions when the Mod fiber is disposed',
    { timeout: 30_000 },
    async () => {
      expect.hasAssertions()
      const { ctx, id } = await assemble()
      const client = getStentClient(ctx)
      await ctx.loader.remove(id)

      expect(() => client.registerCommand(sameCommand())).not.toThrow()
      expect(() =>
        client.registerSlot({ name: 'root' }, stubComponent),
      ).not.toThrow()

      await ctx.fiber.dispose()
    },
  )
})
