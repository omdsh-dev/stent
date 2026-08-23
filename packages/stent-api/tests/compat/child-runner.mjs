/**
 * Child-process harness for the Stent compat adapter spec: each case runs in
 * a fresh Node process so the synchronous module hooks and the
 * already-transformed module cache never leak between cases. The bridge must
 * be installed before the target module is imported, so installation order
 * is part of what each case exercises.
 */

import { Context } from '@deepseek-ai/cordis'
import { installStentHooks, StentService, getStent, markStentDshLaunch } from '@oh-my-dsh/stent'
import { StentCompatService } from '../../src/compat/service.ts'
import { buildCompatInstrumentations } from '../../src/compat/instrumentation.ts'

// The child harness models the approved stent-dsh launch path. The dedicated
// runtime tests cover the plain-dsh rejection path.
markStentDshLaunch()

const fixtureUrl = new URL('../fixtures/node_modules/stent-compat-target/index.mjs', import.meta.url)

const functionQuery = { functionName: 'greet', kind: 'Sync' }

const config = {
  targets: [
    {
      name: 'greet',
      patch: {
        id: 'compat/greet-observe',
        target: {
          module: 'stent-compat-target',
          versionRange: '^1.0.0',
          filePath: 'index.mjs',
          functionQuery,
        },
        operation: 'after',
      },
    },
  ],
}

/** Report one check line; mark the process failed on mismatch. */
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expect ${JSON.stringify(expected)})`}`)
  if (!ok) process.exitCode = 1
}

const caseName = process.argv[2]

if (caseName === 'observe') {
  installStentHooks(buildCompatInstrumentations(config))
  const mod = await import(fixtureUrl)
  const ctx = new Context()
  await ctx.plugin(StentService)
  await ctx.plugin(StentCompatService, config)
  const seen = []
  const dispose = ctx.stentCompat.observe('greet', (call) => { seen.push(call.result) })
  check('observe results', `${mod.greet('world')},${mod.greet('stent')}`, 'hello world,hello stent')
  check('observe seen', seen.join('|'), 'hello world|hello stent')
  dispose()
  mod.greet('again')
  check('observe after dispose', seen.length, 2)
  await ctx.fiber.dispose()
} else if (caseName === 'noBridge') {
  // No installStentHooks: the bridge is absent even though ctx.stent exists.
  const ctx = new Context()
  await ctx.plugin(StentService)
  let threw = ''
  try {
    await ctx.plugin(StentCompatService, config)
    ctx.stentCompat.observe('greet', () => {})
  } catch (error) {
    threw = error.message
  }
  check('noBridge throws', threw.startsWith('stent-compat: the Stent bridge is not installed'), true)
  await ctx.fiber.dispose()
} else if (caseName === 'unknownTarget') {
  installStentHooks([])
  const ctx = new Context()
  await ctx.plugin(StentService)
  await ctx.plugin(StentCompatService, config)
  let threw = ''
  try {
    ctx.stentCompat.observe('missing', () => {})
  } catch (error) {
    threw = error.message
  }
  check('unknown target throws', threw.includes('unknown target "missing"'), true)
  await ctx.fiber.dispose()
} else if (caseName === 'registerPatch') {
  // The runtime registration binds a handler to a transform installed at
  // load time (here: a second instrumentation alongside the observe targets
  // — in a real deployment the launcher bootstrap's config.stent.patches
  // carries it). The facade's id namespace stays exclusive: an id claimed
  // by a declared observation target fails loud.
  installStentHooks([
    ...buildCompatInstrumentations(config),
    {
      channelName: 'compat/greet-upper',
      module: { name: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs' },
      functionQuery: { functionName: 'greet', kind: 'Sync' },
      transform: 'stent',
      stentPatchId: 'compat/greet-upper',
      stentOperation: 'after',
      stentPriority: 0,
      astQuery: 'FunctionDeclaration[id.name="greet"][async], VariableDeclarator[id.name="greet"] > FunctionExpression[async], VariableDeclarator[id.name="greet"] > ArrowFunctionExpression[async]',
    },
  ])
  const mod = await import(fixtureUrl)
  const ctx = new Context()
  await ctx.plugin(StentService)
  await ctx.plugin(StentCompatService, config)
  const id = ctx.stentCompat.registerPatch({
    id: 'compat/greet-upper',
    target: { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery },
    operation: 'after',
    handler(call) {
      return String(call.result).toUpperCase()
    },
  })
  check('registerPatch returns id', id, 'compat/greet-upper')
  check('registerPatch rewrites', mod.greet('world'), 'HELLO WORLD')
  // The facade's id namespace is exclusive: an id claimed by a declared
  // observation target, or by an earlier registration, fails loud — the
  // low-level registry would silently update instead.
  let threw = ''
  try {
    ctx.stentCompat.registerPatch({
      id: 'compat/greet-observe',
      target: { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery },
      operation: 'after',
      handler() {},
    })
  } catch (error) {
    threw = error.message
  }
  check('registerPatch target-id conflict throws', threw.includes('already claimed'), true)
  threw = ''
  try {
    ctx.stentCompat.registerPatch({
      id: 'compat/greet-upper',
      target: { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery },
      operation: 'after',
      handler() {},
    })
  } catch (error) {
    threw = error.message
  }
  check('registerPatch self conflict throws', threw.includes('already claimed'), true)
  // Unregistering disables the handler; transformed code delegates to the
  // original body.
  ctx.stentCompat.unregisterPatch(id)
  check('unregister delegates to original', mod.greet('world'), 'hello world')
  // Unregistering removes the entry: a later re-registration starts a fresh
  // ownership cycle instead of inheriting the first registration's effect.
  ctx.stentCompat.registerPatch({
    id: 'compat/greet-upper',
    target: { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery },
    operation: 'after',
    handler(call) {
      return String(call.result).toUpperCase()
    },
  })
  check('re-register after unregister rewrites', mod.greet('world'), 'HELLO WORLD')
  await ctx.fiber.dispose()
} else if (caseName === 'hmr') {
  // Single-plugin hot reload, direct low-level registration (the browser
  // plugin path): the plugin's new generation registers its patch while the
  // old generation still owns it — the overlapping window of an HMR swap.
  // The old generation's unload must not unregister the new generation's
  // hook.
  installStentHooks([
    {
      channelName: 'compat/greet-upper',
      module: { name: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs' },
      functionQuery: { functionName: 'greet', kind: 'Sync' },
      transform: 'stent',
      stentPatchId: 'compat/greet-upper',
      stentOperation: 'after',
      stentPriority: 0,
      astQuery: 'FunctionDeclaration[id.name="greet"][async], VariableDeclarator[id.name="greet"] > FunctionExpression[async], VariableDeclarator[id.name="greet"] > ArrowFunctionExpression[async]',
    },
  ])
  const mod = await import(fixtureUrl)
  const ctx = new Context()
  const patch = {
    id: 'compat/greet-upper',
    target: { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery },
    operation: 'after',
    handler(call) {
      return String(call.result).toUpperCase()
    },
  }
  const hostPlugin = async (app) => { getStent(app).register(patch) }
  const gen1 = await ctx.plugin(hostPlugin)
  check('hmr gen1 rewrites', mod.greet('world'), 'HELLO WORLD')
  // Generation 2 (the same plugin callback, re-applied) registers while gen1
  // still owns the patch — the overlapping window of a hot reload.
  const gen2 = await ctx.plugin(hostPlugin)
  check('hmr gen2 rewrites', mod.greet('stent'), 'HELLO STENT')
  // Generation 1 unloads; its cleanup must not unregister gen2's hook.
  await gen1.dispose()
  check('hmr gen2 survives gen1 unload', mod.greet('after'), 'HELLO AFTER')
  await gen2.dispose()
  check('hmr gen2 unload restores original', mod.greet('again'), 'hello again')
  await ctx.fiber.dispose()
} else if (caseName === 'compatHmr') {
  // Single-plugin hot reload through the cooperative facade (the crawler
  // shape): disposing generation 1 fully, then re-applying the plugin must
  // leave generation 2's runtime patch and observation fully functional.
  installStentHooks([
    ...buildCompatInstrumentations(config),
    {
      channelName: 'compat/greet-upper',
      module: { name: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs' },
      functionQuery: { functionName: 'greet', kind: 'Sync' },
      transform: 'stent',
      stentPatchId: 'compat/greet-upper',
      stentOperation: 'after',
      stentPriority: 0,
      astQuery: 'FunctionDeclaration[id.name="greet"][async], VariableDeclarator[id.name="greet"] > FunctionExpression[async], VariableDeclarator[id.name="greet"] > ArrowFunctionExpression[async]',
    },
  ])
  const mod = await import(fixtureUrl)
  const ctx = new Context()
  const seen = []
  const hostPlugin = async (app) => {
    await app.plugin(StentCompatService, config)
    const compat = app.get('stentCompat')
    if (compat === undefined) throw new Error('stentCompat unavailable')
    compat.registerPatch({
      id: 'compat/greet-upper',
      target: { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery },
      operation: 'after',
      handler(call) {
        return String(call.result).toUpperCase()
      },
    })
    return compat.observe('greet', (call) => { seen.push(call.result) })
  }
  const gen1 = await ctx.plugin(hostPlugin)
  check('compatHmr gen1 rewrites', mod.greet('world'), 'HELLO WORLD')
  check('compatHmr gen1 observed', seen.join('|'), 'hello world')
  // Full unload of generation 1 (the loader disposes before re-applying).
  await gen1.dispose()
  check('compatHmr gen1 unload restores original', mod.greet('world'), 'hello world')
  const gen2 = await ctx.plugin(hostPlugin)
  check('compatHmr gen2 rewrites', mod.greet('stent'), 'HELLO STENT')
  check('compatHmr gen2 observed', seen.join('|'), 'hello world|hello stent')
  await gen2.dispose()
  check('compatHmr gen2 unload restores original', mod.greet('again'), 'hello again')
  await ctx.fiber.dispose()
} else if (caseName === 'sameId') {
  // A patch id is exclusive to one plugin: a different plugin claiming the
  // same id through the low-level registry fails loud instead of silently
  // overwriting the incumbent's hook.
  installStentHooks([
    {
      channelName: 'compat/shared',
      module: { name: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs' },
      functionQuery: { functionName: 'greet', kind: 'Sync' },
      transform: 'stent',
      stentPatchId: 'compat/shared',
      stentOperation: 'after',
      stentPriority: 0,
      astQuery: 'FunctionDeclaration[id.name="greet"][async], VariableDeclarator[id.name="greet"] > FunctionExpression[async], VariableDeclarator[id.name="greet"] > ArrowFunctionExpression[async]',
    },
  ])
  const mod = await import(fixtureUrl)
  const ctx = new Context()
  const sharedTarget = { module: 'stent-compat-target', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery }
  const pluginA = async (app) => {
    getStent(app).register({
      id: 'compat/shared',
      target: sharedTarget,
      operation: 'after',
      handler(call) {
        return String(call.result).toUpperCase()
      },
    })
  }
  const pluginB = async (app) => {
    getStent(app).register({
      id: 'compat/shared',
      target: sharedTarget,
      operation: 'after',
      handler() {},
    })
  }
  const fiberA = await ctx.plugin(pluginA)
  let threw = ''
  try {
    await ctx.plugin(pluginB)
  } catch (error) {
    threw = error.message
  }
  check('sameId cross-plugin claim throws', threw.includes('already registered by another owner'), true)
  check('sameId incumbent still hooks', mod.greet('world'), 'HELLO WORLD')
  await fiberA.dispose()
  check('sameId incumbent unload restores original', mod.greet('world'), 'hello world')
  await ctx.fiber.dispose()
}
