/**
 * Child-process harness for the async `module.register` fallback: forces the
 * async hook path (STENT_FORCE_ASYNC_HOOKS=1) and runs the fixture
 * through the loader-thread hook entry. Runs against the BUILT lib (plain
 * Node, no tsx) because the hook entry is a build artifact the loader thread
 * resolves next to the built loader.
 */

import { installStentHooks, retransformEsm, runtime } from '../../lib/index.js'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

const patch = {
  id: 'async/before-add',
  target: {
    module: 'stent-target-fixture',
    versionRange: '^1.0.0',
    filePath: 'index.mjs',
    functionQuery: { functionName: 'add', kind: 'Sync' },
  },
  operation: 'before',
  handler(call) {
    call.arguments[0] = call.arguments[0] * 10
  },
}

const fixture = new URL('../fixtures/node_modules/stent-target-fixture/index.mjs', import.meta.url)

/** Register metadata and install a live handler for a test patch. */
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

installStentHooks()
registerPatch(patch)
const mod = await import(fixture.href)
const actual = mod.add(2, 3)
const ok = actual === 23
console.log(`${ok ? 'PASS' : 'FAIL'} async-fallback add(2,3): ${JSON.stringify(actual)}${ok ? '' : ' (expect 23)'}`)
if (!ok) process.exitCode = 1

const dynamicPatch = {
  id: 'async/dynamic-greet',
  target: {
    module: 'stent-target-fixture',
    versionRange: '^1.0.0',
    filePath: 'index.mjs',
    functionQuery: { functionName: 'greet', kind: 'Sync' },
  },
  operation: 'after',
  handler(call) {
    return `${call.result}!`
  },
}
registerPatch(dynamicPatch)
const dynamicMod = await import(`${fixture.href}?dynamic=1`)
const dynamicActual = dynamicMod.greet('world')
const dynamicOk = dynamicActual === 'hello world!'
console.log(`${dynamicOk ? 'PASS' : 'FAIL'} async-fallback dynamic greet(world): ${JSON.stringify(dynamicActual)}${dynamicOk ? '' : ' (expect "hello world!")'}`)
if (!dynamicOk) process.exitCode = 1
runtime.remove(dynamicPatch.id)

// CommonJS never reaches the loader-thread load hook (plain require() skips
// it); the main-thread _compile patch must transform it on the async path.
const cjsPatch = {
  id: 'async/before-add-cjs',
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

registerPatch(cjsPatch)
const cjs = require(new URL('../fixtures/node_modules/stent-target-fixture/index.cjs', import.meta.url).pathname)
const cjsActual = cjs.add(2, 3)
const cjsOk = cjsActual === 23
console.log(`${cjsOk ? 'PASS' : 'FAIL'} async-fallback cjs add(2,3): ${JSON.stringify(cjsActual)}${cjsOk ? '' : ' (expect 23)'}`)
if (!cjsOk) process.exitCode = 1

// ESM re-transformation works on the async path too: removing the first
// runtime patch and registering a new one updates the shared loader-thread
// configuration before the explicit re-import.
runtime.remove(patch.id)
const patchV2 = {
  id: 'async/esm-v2',
  target: patch.target,
  operation: 'before',
  handler(call) {
    call.arguments[0] = call.arguments[0] * 100
  },
}
registerPatch(patchV2)
const reloaded = await retransformEsm(fixture.href)
const reloadedActual = reloaded.add(2, 3)
const reloadedOk = reloadedActual === 203
console.log(`${reloadedOk ? 'PASS' : 'FAIL'} async-fallback reloaded add(2,3): ${JSON.stringify(reloadedActual)}${reloadedOk ? '' : ' (expect 203)'}`)
if (!reloadedOk) process.exitCode = 1

// One dynamic matcher merges all runtime registrations and applies the
// configured priority order: the higher-priority A handler runs first.
const greetTarget = {
  module: 'stent-target-fixture',
  versionRange: '^1.0.0',
  filePath: 'index.mjs',
  functionQuery: { functionName: 'greet', kind: 'Sync' },
}
const greetA = {
  id: 'async/greet-a',
  target: greetTarget,
  operation: 'before',
  priority: 10,
  handler(call) {
    call.arguments[0] = `${call.arguments[0]}A`
  },
}
const greetB = {
  id: 'async/greet-b',
  target: greetTarget,
  operation: 'before',
  priority: 0,
  handler(call) {
    call.arguments[0] = `${call.arguments[0]}B`
  },
}
registerPatch(greetA)
registerPatch(greetB)
const restacked = await retransformEsm(fixture.href)
const stackedActual = restacked.greet('world')
const stackedOk = stackedActual === 'hello worldAB'
console.log(`${stackedOk ? 'PASS' : 'FAIL'} async-fallback stacked greet(world): ${JSON.stringify(stackedActual)}${stackedOk ? '' : ' (expect "hello worldAB")'}`)
if (!stackedOk) process.exitCode = 1
