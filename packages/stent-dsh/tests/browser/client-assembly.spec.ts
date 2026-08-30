import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { apply, StentClientService } from '../../src/browser/client/index.ts'
import { materialize, prepareClientBundles, seedMap } from './module-loader.ts'

const packageRoot = process.cwd()

// ui-primitives is a heavy render-only package (markdown/highlighting);
// the command service only touches it on render paths, so stub it in the
// module table instead of pulling its dependency tree into tests.
seedMap({ '@deepseek-ai/dsh-client-ui-primitives': {} })

// The registry browser bundles ship in the dsh closure-factory format
// (window.__ModuleLoader__.load), so the real CommandUiRuntime and
// SlotRegistry are loaded through the test module loader: seed the platform
// table, register the bundles, and materialize their factories. The types
// arrive type-only from the registry packages (the runtime declares the
// slots/changed event bridge).
await prepareClientBundles(
  [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    'react',
    'react/jsx-runtime',
  ],
  [
    '@deepseek-ai/dsh-client-ui-commands/client',
    '@deepseek-ai/dsh-client-runtime/client',
  ],
)
const { CommandUiRuntime } = materialize<
  typeof import('@deepseek-ai/dsh-client-ui-commands/client')
>('@deepseek-ai/dsh-client-ui-commands')
const { SlotRegistry } = materialize<
  typeof import('@deepseek-ai/dsh-client-runtime/client')
>('@deepseek-ai/dsh-client-runtime')

/**
 * Browser assembly: the real browser command and slot services (the `stent-dsh`
 * client row's `ctx.command`/`ctx.slots` delegates) over fake
 * slash/sessions/connection faces, plus the real Loader booting an unmodified
 * browser fixture Mod through `ctx.stentClient`. This mirrors the web-roster
 * composition with the opt-in row enabled.
 */
async function assemble() {
  const ctx = new Context()
  // The Loader resolves entries against ctx.baseUrl; under happy-dom the
  // environment location is http://localhost:3000, so pin the base (and the
  // fixture url below) to real file paths from the package root.
  ctx.baseUrl = join(packageRoot, 'tests')
  ctx.provide('inputTriggers', {
    registerSource() {
      return () => {}
    },
  })
  ctx.provide('sessions', {
    scope: () => undefined,
    scopeOf: () => undefined,
  })
  const commandsRemote = { list: () => Promise.resolve([]) }
  // CommandUiRuntime injects `remote` for the forwarded directory invalidation.
  ctx.provide('remote', { commands: commandsRemote, $on: () => () => {} })
  ctx.provide('remote.commands', commandsRemote)
  await ctx.plugin(SlotRegistry).await()
  await ctx.plugin(CommandUiRuntime).await()
  await apply(ctx)
  // Observe the slot registry notifications from the Mod's registration.
  const changed: string[] = []
  const listen = ctx.on('slots/changed', (key: string) => {
    changed.push(key)
  })
  await ctx.plugin(Loader)
  const id = await ctx.loader.create({
    name: pathToFileURL(
      join(
        packageRoot,
        'tests/fixtures/node_modules/stent-client-fixture-mod/index.mjs',
      ),
    ).href,
  })
  await ctx.loader.await()
  return { ctx, id, changed, listen }
}

const sameCommand = (): CommandContribution => ({
  name: 'modclientcmd',
  description: 'fixture client command',
  available: () => true,
  ui: {
    kind: 'popupSelect',
    options: () => Promise.resolve([]),
    onSelect: () => {},
  },
})

describe('Stent API browser assembly', () => {
  it('boots a browser fixture Mod whose contributions reach the real client services', async () => {
    const { ctx, id, changed, listen } = await assemble()
    const client = ctx.get('stentClient') as StentClientService

    // The client command contribution lives in the authoritative command
    // service: a duplicate registration fails loud while it is live.
    expect(() => client.registerCommand(sameCommand())).toThrow()

    // The slot contribution reached the real slot registry: the single 'root'
    // hole is occupied, and the registration emitted slots/changed.
    expect(() => client.registerSlot({ name: 'root' }, () => null)).toThrow(
      /single/,
    )
    expect(changed).toContain('root')
    listen()

    await ctx.loader.remove(id)

    // HMR: both contributions are gone with the Mod fiber.
    expect(() => client.registerCommand(sameCommand())).not.toThrow()
    expect(() =>
      client.registerSlot({ name: 'root' }, () => null),
    ).not.toThrow()

    await ctx.fiber.dispose()
  })
})
