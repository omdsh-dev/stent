/**
 * Child-process harness for the Stent integration spec: each case runs in a
 * fresh Node process so the synchronous module hooks (which cannot be
 * unregistered) and the already-transformed module cache never leak between
 * cases. The child imports the Stent source entry through the package's
 * `./src/*` export and is launched with tsx from the repository root.
 */

import { checkRequiredPatches, installStentHooks, retransformCommonJs, retransformEsm } from '../../src/node/index.ts'
import { runtime, GLOBAL_BRIDGE_KEY } from '../../src/index.ts'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const fixtureUrl = new URL('../fixtures/node_modules/stent-target-fixture/index.mjs', import.meta.url)

const target = {
  module: 'stent-target-fixture',
  versionRange: '^1.0.0',
  filePath: 'index.mjs',
}

/** Report one check line; mark the process failed on mismatch. */
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expect ${JSON.stringify(expected)})`}`)
  if (!ok) process.exitCode = 1
}

/** Register and enable one patch through the live runtime registry. */
function registerPatch(patch) {
  runtime.register({
    id: patch.id,
    target: patch.target,
    operation: patch.operation,
    priority: patch.priority ?? 0,
    ...(patch.required === undefined ? {} : { required: patch.required }),
    enabled: false,
  })
  if (typeof patch.handler === 'function') runtime.enable(patch.id, patch.handler)
}

/** Install the dynamic hooks, register one patch, then run the checks. */
async function withPatch(patch, checks) {
  installStentHooks()
  registerPatch(patch)
  const mod = await import(fixtureUrl)
  await checks(mod)
}

const caseName = process.argv[2]

/** Wait until the async hook path's port-delivered binding records for a
 * patch reach the expected count (they land asynchronously; production
 * reads them after boot), giving up after about a second. */
const flushBindings = async (id, count) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (runtime.bindingsOf(id).length >= count) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

switch (caseName) {
  case 'installGuard': {
    const errors = []
    for (const args of [[[{ id: 'legacy/static' }], { dynamic: true }], [{ dynamic: true }], [undefined]]) {
      try {
        installStentHooks(...args)
      } catch (error) {
        errors.push(String(error))
      }
    }
    check('installGuard rejects every call with arguments', errors.length, 3)
    check('installGuard explains the no-argument form', errors.every(error => error.includes('installStentHooks()')), true)
    const dispose = installStentHooks()
    let duplicateError = ''
    try {
      installStentHooks()
    } catch (error) {
      duplicateError = String(error)
    } finally {
      dispose()
    }
    check('installGuard accepts installStentHooks', typeof dispose, 'function')
    check('installGuard rejects duplicate active installation', duplicateError.includes('one active dynamic installation'), true)
    break
  }

  case 'dynamicBefore':
    installStentHooks()
    runtime.register({
      id: 'e2e/dynamic-before',
      target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
      operation: 'before',
      priority: 0,
      enabled: false,
    })
    runtime.enable('e2e/dynamic-before', call => {
      call.arguments[0] *= 10
    })
    {
      const mod = await import(fixtureUrl)
      check('dynamicBefore add(2,3)', mod.add(2, 3), 23)
    }
    break

  case 'dynamicBurst':
    {
      installStentHooks()
      const mod = await import(fixtureUrl)
      const addTarget = { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } }
      const first = {
        id: 'e2e/burst-first',
        target: addTarget,
        operation: 'before',
        handler(call) {
          call.arguments[0] *= 10
        },
      }
      const second = {
        id: 'e2e/burst-second',
        target: addTarget,
        operation: 'before',
        handler(call) {
          call.arguments[0] *= 100
        },
      }
      runtime.register({ id: first.id, target: first.target, operation: first.operation, priority: 0, enabled: false })
      runtime.enable(first.id, first.handler)
      runtime.register({ id: second.id, target: second.target, operation: second.operation, priority: 0, enabled: false })
      runtime.enable(second.id, second.handler)
      runtime.remove(first.id)
      await new Promise(resolve => setTimeout(resolve, 100))
      const current = await import(fixtureUrl)
      check('dynamicBurst final patch after register/remove burst', current.add(2, 3), 203)
      runtime.remove(second.id)
      await new Promise(resolve => setTimeout(resolve, 100))
      const restored = await import(fixtureUrl)
      check('dynamicBurst original after removal burst', restored.add(2, 3), 5)
    }
    break

  case 'dynamicLoaded':
    installStentHooks()
    {
      const first = await import(fixtureUrl)
      check('dynamicLoaded original add(2,3)', first.add(2, 3), 5)
      runtime.register({
        id: 'e2e/dynamic-loaded',
        target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
        priority: 0,
        enabled: false,
      })
      runtime.enable('e2e/dynamic-loaded', call => {
        call.arguments[0] *= 10
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      const second = await import(fixtureUrl)
      check('dynamicLoaded patched add(2,3)', second.add(2, 3), 23)
      await flushBindings('e2e/dynamic-loaded', 1)
      check('dynamicLoaded bindings', runtime.bindingsOf('e2e/dynamic-loaded').length, 1)
    }
    break
  case 'before':
    await withPatch({
      id: 'e2e/before-add',
      target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
      operation: 'before',
      handler(call) {
        call.arguments[0] = call.arguments[0] * 10
      },
    }, async (mod) => {
      check('before add(2,3)', mod.add(2, 3), 23)
    })
    break

  case 'after':
    await withPatch({
      id: 'e2e/after-greet',
      target: { ...target, functionQuery: { functionName: 'greet', kind: 'Sync' } },
      operation: 'after',
      handler(call) {
        return String(call.result).toUpperCase()
      },
    }, async (mod) => {
      check('after greet(world)', mod.greet('world'), 'HELLO WORLD')
    })
    break

  case 'around':
    await withPatch({
      id: 'e2e/around-add',
      target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
      operation: 'around',
      handler(call, invoke) {
        if (call.arguments[0] === 99) return 'vetoed'
        return invoke()
      },
    }, async (mod) => {
      check('around add(99,1)', mod.add(99, 1), 'vetoed')
      check('around add(1,2)', mod.add(1, 2), 3)
    })
    break

  case 'replace':
    await withPatch({
      id: 'e2e/replace-multiply',
      target: {
        ...target,
        functionQuery: { className: 'Calc', methodName: 'multiply', kind: 'Sync' },
      },
      operation: 'replace',
      handler(call) {
        return call.arguments[0] * 1000
      },
    }, async (mod) => {
      check('replace Calc.multiply(5)', new mod.Calc(3).multiply(5), 5000)
    })
    break

  case 'afterAsync':
    await withPatch({
      id: 'e2e/after-fetch',
      target: { ...target, functionQuery: { functionName: 'fetchCount', kind: 'Async' } },
      operation: 'after',
      handler(call) {
        return String(call.result).toUpperCase()
      },
    }, async (mod) => {
      check('afterAsync fetchCount(ab)', await mod.fetchCount('ab'), 'COUNT:2')
    })
    break

  case 'afterAsyncMutate':
    await withPatch({
      id: 'e2e/after-fetch-mutate',
      target: { ...target, functionQuery: { functionName: 'fetchCount', kind: 'Async' } },
      operation: 'after',
      handler(call) {
        // In-place mutation with no replacement value must keep the result.
        call.result = String(call.result).toUpperCase()
      },
    }, async (mod) => {
      check('afterAsyncMutate fetchCount(ab)', await mod.fetchCount('ab'), 'COUNT:2')
    })
    break

  case 'afterMutate':
    await withPatch({
      id: 'e2e/after-mutate',
      target: { ...target, functionQuery: { functionName: 'greet', kind: 'Sync' } },
      operation: 'after',
      handler(call) {
        call.result = String(call.result).toUpperCase()
      },
    }, async (mod) => {
      check('afterMutate greet(world)', mod.greet('world'), 'HELLO WORLD')
    })
    break

  case 'asyncAwait':
    await withPatch({
      id: 'e2e/async-await',
      target: { ...target, functionQuery: { functionName: 'withAwait', kind: 'Async' } },
      operation: 'after',
      handler(call) {
        return call.result * 10
      },
    }, async (mod) => {
      check('asyncAwait withAwait(2)', await mod.withAwait(2), 50)
    })
    break

  case 'generator':
    {
      // Generators transform through delegation: without a handler publish
      // hands back the traced generator and `yield*` preserves iteration; a
      // before handler's argument mutation flows into the replayed generator.
      const patch = {
        id: 'e2e/generator-before',
        target: { ...target, functionQuery: { functionName: 'counter', kind: 'Sync' } },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 2
        },
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      const mod = await import(fixtureUrl)
      check('generator untouched counter(3)', JSON.stringify([...mod.counter(3)]), JSON.stringify([0, 1, 2]))
      runtime.enable(patch.id, patch.handler)
      check('generator patched counter(3)', JSON.stringify([...mod.counter(3)]), JSON.stringify([0, 1, 2, 3, 4, 5]))
    }
    break

  case 'asyncGenerator':
    {
      const patch = {
        id: 'e2e/async-gen-before',
        target: { ...target, functionQuery: { functionName: 'asyncCounter', kind: 'Async' } },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 2
        },
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      const mod = await import(fixtureUrl)
      runtime.enable(patch.id, patch.handler)
      const out = []
      for await (const value of mod.asyncCounter(3)) out.push(value)
      check('asyncGenerator patched asyncCounter(3)', JSON.stringify(out), JSON.stringify([0, 1, 2, 3, 4, 5]))
    }
    break

  case 'arrow':
    await withPatch({
      id: 'e2e/arrow-double',
      target: { ...target, functionQuery: { functionName: 'double', kind: 'Sync' } },
      operation: 'before',
      handler(call) {
        call.arguments[0] = call.arguments[0] * 10
      },
    }, async (mod) => {
      check('arrow double(2)', mod.double(2), 40)
    })
    break

  case 'arrowRest':
    await withPatch({
      id: 'e2e/arrow-rest',
      target: { ...target, functionQuery: { functionName: 'sumRest', kind: 'Sync' } },
      operation: 'before',
      handler(call) {
        call.arguments[0] = call.arguments[0] * 10
      },
    }, async (mod) => {
      check('arrowRest sumRest(1,2,3)', mod.sumRest(1, 2, 3), 15)
    })
    break

  case 'arrowDefault':
    await withPatch({
      id: 'e2e/arrow-default',
      target: { ...target, functionQuery: { functionName: 'withDefault', kind: 'Sync' } },
      operation: 'before',
      handler(call) {
        call.arguments[0] = call.arguments[0] * 10
      },
    }, async (mod) => {
      check('arrowDefault withDefault(2)', mod.withDefault(2), 30)
      check('arrowDefault withDefault(2,3)', mod.withDefault(2, 3), 23)
    })
    break

  case 'arrowDestructure':
    await withPatch({
      id: 'e2e/arrow-destructure',
      target: { ...target, functionQuery: { functionName: 'pickName', kind: 'Sync' } },
      operation: 'before',
      handler(call) {
        call.arguments[0].name = 'z'
      },
    }, async (mod) => {
      check('arrowDestructure pickName', mod.pickName({ name: 'n', meta: { tag: 't' } }, ['a', 'b', 'c']), 'z:t:a:2')
    })
    break

  case 'arrowOuterArgs':
    await withPatch({
      id: 'e2e/arrow-outer-args',
      target: { ...target, functionQuery: { functionName: 'inner', kind: 'Sync' } },
      operation: 'after',
      handler(call) {
        return String(call.result * 10)
      },
    }, async (mod) => {
      check('arrowOuterArgs callOuterArgs(7)', mod.callOuterArgs(7), '140')
    })
    break

  case 'priorityOrder':
    installStentHooks()
    {
      const order = []
      const functionQuery = { functionName: 'add', kind: 'Sync' }
      runtime.register({ id: 'e2e/prio-low', target: { ...target, functionQuery }, operation: 'before', priority: 0, enabled: false })
      runtime.enable('e2e/prio-low', () => { order.push('low') })
      runtime.register({ id: 'e2e/prio-high', target: { ...target, functionQuery }, operation: 'before', priority: 10, enabled: false })
      runtime.enable('e2e/prio-high', () => { order.push('high') })
      const mod = await import(fixtureUrl)
      mod.add(2, 3)
      check('priority order add(2,3)', order.join(','), 'high,low')
    }
    break

  case 'priorityStable':
    installStentHooks()
    {
      const order = []
      const functionQuery = { functionName: 'add', kind: 'Sync' }
      runtime.register({ id: 'e2e/stable-first', target: { ...target, functionQuery }, operation: 'before', priority: 5, enabled: false })
      runtime.enable('e2e/stable-first', () => { order.push('first') })
      runtime.register({ id: 'e2e/stable-second', target: { ...target, functionQuery }, operation: 'before', priority: 5, enabled: false })
      runtime.enable('e2e/stable-second', () => { order.push('second') })
      const mod = await import(fixtureUrl)
      mod.add(2, 3)
      // Equal priorities keep registration order: the later instrumentation
      // wraps the outermost layer, so its handler runs first.
      check('priority stable add(2,3)', order.join(','), 'second,first')
    }
    break

  case 'collide':
    await withPatch({
      id: 'e2e/collide-param',
      target: { ...target, functionQuery: { functionName: 'collide', kind: 'Sync' } },
      operation: 'before',
      handler(call) {
        call.arguments[0] = call.arguments[0] * 2
      },
    }, async (mod) => {
      check('collide param (2)', mod.collide(2), 5)
    })
    break

  case 'noBridge':
    {
      const patch = {
        id: 'e2e/no-bridge',
        target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 10
        },
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      const mod = await import(fixtureUrl)
      runtime.enable(patch.id, patch.handler)
      // A browser-like scenario: the module is transformed at build time but
      // the bridge is not installed yet (no StentService mounted). Calls must
      // fall back to the original body instead of throwing.
      delete globalThis[GLOBAL_BRIDGE_KEY]
      check('noBridge add(2,3) falls back', mod.add(2, 3), 5)
    }
    break

  case 'dynamicRemove':
    installStentHooks()
    {
      const patch = {
        id: 'e2e/dynamic-remove',
        target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
      }
      runtime.register({ ...patch, priority: 0, enabled: false })
      runtime.enable(patch.id, call => {
        call.arguments[0] *= 10
      })
      const first = await import(fixtureUrl)
      check('dynamicRemove patched add(2,3)', first.add(2, 3), 23)
      runtime.remove(patch.id)
      await new Promise(resolve => setTimeout(resolve, 50))
      const second = await import(fixtureUrl)
      check('dynamicRemove original add(2,3)', second.add(2, 3), 5)
    }
    break

  case 'dynamicRequired':
    installStentHooks()
    runtime.register({
      id: 'e2e/dynamic-required',
      target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
      operation: 'before',
      priority: 0,
      required: true,
      enabled: false,
    })
    runtime.enable('e2e/dynamic-required', () => {})
    await import(fixtureUrl)
    await flushBindings('e2e/dynamic-required', 1)
    let threw = ''
    try {
      checkRequiredPatches()
    } catch (error) {
      threw = String(error)
    }
    check('dynamicRequired no throw', threw, '')
    check('dynamicRequired bindings', runtime.bindingsOf('e2e/dynamic-required').length, 1)
    break

  case 'dynamicCjs':
    installStentHooks()
    {
      const cjsPath = new URL('../fixtures/node_modules/stent-target-fixture/index.cjs', import.meta.url).pathname
      const first = require(cjsPath)
      check('dynamicCjs original add(2,3)', first.add(2, 3), 5)
      runtime.register({
        id: 'e2e/dynamic-cjs',
        target: {
          module: 'stent-target-fixture',
          versionRange: '^1.0.0',
          filePath: 'index.cjs',
          functionQuery: { methodName: 'add', kind: 'Sync' },
        },
        operation: 'before',
        priority: 0,
        enabled: false,
      })
      runtime.enable('e2e/dynamic-cjs', call => {
        call.arguments[0] *= 10
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      const second = require(cjsPath)
      check('dynamicCjs patched add(2,3)', second.add(2, 3), 23)
    }
    break

  case 'cjs':
    {
      const patch = {
        id: 'e2e/cjs-before',
        target: {
          module: 'stent-target-fixture',
          versionRange: '^1.0.0',
          filePath: 'index.cjs',
          functionQuery: { methodName: 'add', kind: 'Sync' },
        },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 10
        },
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      const cjs = require(new URL('../fixtures/node_modules/stent-target-fixture/index.cjs', import.meta.url).pathname)
      check('cjs baseline add(2,3)', cjs.add(2, 3), 5)
      runtime.enable(patch.id, patch.handler)
      check('cjs patched add(2,3)', cjs.add(2, 3), 23)
    }
    break

  case 'retransform':
    {
      const cjsPath = new URL('../fixtures/node_modules/stent-target-fixture/index.cjs', import.meta.url).pathname
      const cjsTarget = {
        module: 'stent-target-fixture',
        versionRange: '^1.0.0',
        filePath: 'index.cjs',
        functionQuery: { methodName: 'add', kind: 'Sync' },
      }
      const patchV1 = {
        id: 'e2e/retransform-v1',
        target: cjsTarget,
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 10
        },
      }
      const disposeV1 = installStentHooks()
      runtime.register({ id: patchV1.id, target: patchV1.target, operation: patchV1.operation, priority: 0, enabled: false })
      const m1 = require(cjsPath)
      runtime.enable(patchV1.id, patchV1.handler)
      check('retransform v1 add(2,3)', m1.add(2, 3), 23)
      const patchV2 = {
        id: 'e2e/retransform-v2',
        target: cjsTarget,
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 100
        },
      }
      // HMR: the old installation is replaced by a new one (its load hook
      // becomes pass-through) before the module is re-evaluated.
      disposeV1()
      runtime.remove(patchV1.id)
      installStentHooks()
      runtime.register({ id: patchV2.id, target: patchV2.target, operation: patchV2.operation, priority: 0, enabled: false })
      runtime.enable(patchV2.id, patchV2.handler)
      // Removing v1 disables its bridge slot on the already-evaluated module.
      check('retransform cached add(2,3)', m1.add(2, 3), 5)
      // ...until retransformCommonJs re-evaluates it under the v2 installation.
      const m2 = retransformCommonJs(cjsPath)
      check('retransform reloaded add(2,3)', m2.add(2, 3), 203)
    }
    break

  case 'retransformEsm':
    {
      const functionQuery = { functionName: 'add', kind: 'Sync' }
      const patchV1 = {
        id: 'e2e/esm-v1',
        target: { ...target, functionQuery },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 10
        },
      }
      const disposeV1 = installStentHooks()
      runtime.register({ id: patchV1.id, target: patchV1.target, operation: patchV1.operation, priority: 0, enabled: false })
      const m1 = await import(fixtureUrl)
      runtime.enable(patchV1.id, patchV1.handler)
      check('retransformEsm v1 add(2,3)', m1.add(2, 3), 23)
      const patchV2 = {
        id: 'e2e/esm-v2',
        target: { ...target, functionQuery },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 100
        },
      }
      // HMR: the old installation is replaced by a new one before the module
      // is evicted from Node's internal loadCache and re-imported.
      disposeV1()
      runtime.remove(patchV1.id)
      installStentHooks()
      runtime.register({ id: patchV2.id, target: patchV2.target, operation: patchV2.operation, priority: 0, enabled: false })
      runtime.enable(patchV2.id, patchV2.handler)
      // Removing v1 disables its bridge slot on the already-evaluated module.
      check('retransformEsm cached add(2,3)', m1.add(2, 3), 5)
      const m2 = await retransformEsm(fixtureUrl.href)
      check('retransformEsm reloaded add(2,3)', m2.add(2, 3), 203)
    }
    break

  case 'retransformEsmRollback':
    {
      const rollbackUrl = new URL('../fixtures/node_modules/stent-target-fixture/rollback.mjs', import.meta.url).href
      const m1 = await import(rollbackUrl)
      check('retransformEsmRollback initial value', m1.value, 1)
      process.env.STENT_ROLLBACK_BOOM = '1'
      let failed = false
      try {
        await retransformEsm(rollbackUrl)
      } catch {
        failed = true
      }
      check('retransformEsmRollback re-import fails', failed, true)
      delete process.env.STENT_ROLLBACK_BOOM
      // The evicted entry was restored: import() serves the previous instance
      // from the cache instead of re-evaluating (which would have thrown again).
      const m2 = await import(rollbackUrl)
      check('retransformEsmRollback restores cached instance', m2 === m1, true)
    }
    break

  case 'retransformCjsDual':
    {
      const cjsPath = new URL('../fixtures/node_modules/stent-target-fixture/index.cjs', import.meta.url).pathname
      const cjsUrl = pathToFileURL(cjsPath).href
      const cjsTarget = {
        module: 'stent-target-fixture',
        versionRange: '^1.0.0',
        filePath: 'index.cjs',
        functionQuery: { methodName: 'add', kind: 'Sync' },
      }
      const patchV1 = {
        id: 'e2e/dual-v1',
        target: cjsTarget,
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 10
        },
      }
      const disposeV1 = installStentHooks()
      runtime.register({ id: patchV1.id, target: patchV1.target, operation: patchV1.operation, priority: 0, enabled: false })
      const esm = await import(cjsUrl)
      const cjs = require(cjsPath)
      runtime.enable(patchV1.id, patchV1.handler)
      check('retransformCjsDual shared instance', esm.add === cjs.add, true)
      check('retransformCjsDual v1 add(2,3)', cjs.add(2, 3), 23)
      const patchV2 = {
        id: 'e2e/dual-v2',
        target: cjsTarget,
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 100
        },
      }
      disposeV1()
      runtime.remove(patchV1.id)
      installStentHooks()
      runtime.register({ id: patchV2.id, target: patchV2.target, operation: patchV2.operation, priority: 0, enabled: false })
      runtime.enable(patchV2.id, patchV2.handler)
      const m2 = retransformCommonJs(cjsPath)
      check('retransformCjsDual reloaded add(2,3)', m2.add(2, 3), 203)
      check('retransformCjsDual old instance detached', m2.add !== cjs.add, true)
      // The ESM graph must observe the fresh evaluation too: the loadCache
      // entry was evicted, so import() re-loads the file (reusing the fresh
      // require.cache entry the reload above created).
      const esm2 = await import(cjsUrl)
      check('retransformCjsDual esm re-import shares reload', esm2.add === m2.add, true)
      check('retransformCjsDual esm add(2,3)', esm2.add(2, 3), 203)
    }
    break

  case 'workspaceIdentity':
    {
      // The workspace-package shape: the module is reached at its real path
      // (no node_modules boundary — Node realpaths workspace links), so the
      // nearest package.json must identify it.
      // This is how host packages load in the real product launch.
      const patch = {
        id: 'e2e/workspace-identity',
        target: {
          module: 'workspace-target-fixture',
          versionRange: '*',
          filePath: 'index.mjs',
          functionQuery: { functionName: 'add', kind: 'Sync' },
        },
        operation: 'before',
        handler(call) {
          call.arguments[0] = call.arguments[0] * 10
        },
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      const wsUrl = new URL('../fixtures/workspace-target-fixture/index.mjs', import.meta.url)
      const mod = await import(wsUrl)
      runtime.enable(patch.id, patch.handler)
      check('workspaceIdentity add(2,3)', mod.add(2, 3), 23)
    }
    break

  case 'bindingsReported':
    {
      // The load-time binding records must reflect the file the transform
      // actually rewrote — the ground truth the required-patch check and the
      // service's bindings() snapshot are built on.
      const patch = {
        id: 'e2e/bindings-add',
        target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
        handler() {},
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      await import(fixtureUrl)
      await flushBindings(patch.id, 1)
      const bindings = runtime.bindingsOf(patch.id)
      check('bindingsReported one record', bindings.length, 1)
      check('bindingsReported module', bindings[0]?.module, 'stent-target-fixture')
      check('bindingsReported file', bindings[0]?.file, 'index.mjs')
      check('bindingsReported nodes', bindings[0]?.nodes, 1)
      // list() carries the binding summary after registration too.
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      const listed = runtime.list().find(info => info.id === patch.id)
      check('bindingsReported list() summary', listed?.bindings.length, 1)
    }
    break

  case 'requiredHit':
    {
      // A required patch whose target bound passes the post-boot check.
      const patch = {
        id: 'e2e/required-add',
        target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
        required: true,
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      await import(fixtureUrl)
      await flushBindings(patch.id, 1)
      let threw = ''
      try {
        checkRequiredPatches()
      } catch (error) {
        threw = String(error)
      }
      check('requiredHit no throw', threw, '')
      check('requiredHit bindings recorded', runtime.bindingsOf(patch.id).length, 1)
    }
    break

  case 'requiredMiss':
    {
      // A required patch whose target never matched must fail loud naming
      // the patch id — the wrong launch form (src vs lib) is the classic
      // silent-miss case this check exists for.
      const patch = {
        id: 'e2e/required-nope',
        target: { ...target, filePath: 'nope.mjs', functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
        required: true,
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      await import(fixtureUrl)
      let threw = ''
      try {
        checkRequiredPatches()
      } catch (error) {
        threw = String(error)
      }
      check('requiredMiss throws', threw.includes('e2e/required-nope'), true)
      check('requiredMiss mentions target', threw.includes('nope.mjs'), true)
      check('requiredMiss zero bindings', runtime.bindingsOf(patch.id).length, 0)
    }
    break

  case 'requiredRegExp':
    {
      // A RegExp filePath covers several launch forms under one patch id —
      // the documented dual-form (src vs lib) idiom — and binds once per
      // matched file.
      const patch = {
        id: 'e2e/required-regexp',
        target: { ...target, filePath: /^(index\.mjs|lib\/index\.js)$/, functionQuery: { functionName: 'add', kind: 'Sync' } },
        operation: 'before',
        required: true,
      }
      installStentHooks()
      runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, required: patch.required, enabled: false })
      await import(fixtureUrl)
      await flushBindings(patch.id, 1)
      let threw = ''
      try {
        checkRequiredPatches()
      } catch (error) {
        threw = String(error)
      }
      check('requiredRegExp no throw', threw, '')
      check('requiredRegExp bindings recorded', runtime.bindingsOf(patch.id).length, 1)
    }
    break

  case 'filePathsDual':
    {
      // The filePaths convenience collapses the dual-form (src vs lib)
      // idiom into one stub: every entry expands into its own
      // instrumentation under the same patch id, one binding record per
      // matched file, and handlers bound to the id see both files' calls.
      const stub = {
        id: 'e2e/filepaths-add',
        target: {
          module: 'stent-target-fixture',
          versionRange: '^1.0.0',
          filePaths: ['index.mjs', 'lib.js'],
          functionQuery: { functionName: 'add', kind: 'Sync' },
        },
        operation: 'before',
      }
      installStentHooks()
      runtime.register({ id: stub.id, target: stub.target, operation: stub.operation, priority: 0, enabled: false })
      const indexMod = await import(fixtureUrl)
      const libUrl = new URL('../fixtures/node_modules/stent-target-fixture/lib.js', import.meta.url)
      const libMod = await import(libUrl)
      await flushBindings(stub.id, 2)
      runtime.enable(stub.id, (call) => { call.arguments[0] = call.arguments[0] * 10 })
      check('filePathsDual index patched', indexMod.add(2, 3), 23)
      check('filePathsDual lib patched', libMod.add(2, 3), 23)
      const bindings = runtime.bindingsOf(stub.id)
      check('filePathsDual two records', bindings.length, 2)
      check('filePathsDual files', bindings.map(b => b.file).sort().join(','), 'index.mjs,lib.js')
    }
    break

  default:
    throw new Error(`unknown case ${caseName}`)
}
