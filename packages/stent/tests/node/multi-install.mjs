/**
 * Dynamic-only regression harness: one live matcher follows runtime
 * registrations, and the registry's priority/disable semantics remain stable.
 */

import { createRequire } from 'node:module'
import { installStentHooks, runtime } from '../../src/index.ts'

const require = createRequire(import.meta.url)

const target = {
  module: 'stent-target-fixture',
  versionRange: '^1.0.0',
  filePath: 'index.mjs',
}

const patchA = {
  id: 'multi/before-add',
  target: { ...target, functionQuery: { functionName: 'add', kind: 'Sync' } },
  operation: 'before',
  handler(call) {
    call.arguments[0] = call.arguments[0] * 10
  },
}
const patchB = {
  id: 'multi/before-greet',
  target: { ...target, functionQuery: { functionName: 'greet', kind: 'Sync' } },
  operation: 'before',
  handler(call) {
    call.arguments[0] = String(call.arguments[0]).toUpperCase()
  },
}

const fixture = new URL('../fixtures/node_modules/stent-target-fixture/index.mjs', import.meta.url)
const cjsFixture = new URL('../fixtures/node_modules/stent-target-fixture/index.cjs', import.meta.url)

/** CJS patches mirroring patchA/patchB, targeting the object-literal methods. */
const cjsTarget = {
  module: 'stent-target-fixture',
  versionRange: '^1.0.0',
  filePath: 'index.cjs',
}
const cjsPatchA = {
  id: 'multi/cjs-before-add',
  target: { ...cjsTarget, functionQuery: { methodName: 'add', kind: 'Sync' } },
  operation: 'before',
  handler(call) {
    call.arguments[0] = call.arguments[0] * 10
  },
}
const cjsPatchB = {
  id: 'multi/cjs-before-greet',
  target: { ...cjsTarget, functionQuery: { methodName: 'greet', kind: 'Sync' } },
  operation: 'before',
  handler(call) {
    call.arguments[0] = String(call.arguments[0]).toUpperCase()
  },
}
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expect ${JSON.stringify(expected)})`}`)
  if (!ok) process.exitCode = 1
}
function reg(p) {
  runtime.register({ id: p.id, target: p.target, operation: p.operation, priority: p.priority ?? 0, enabled: false })
  runtime.enable(p.id, p.handler)
}

const scenario = process.argv[2]

if (scenario === 'registered') {
  // Multiple plugin registrations share the one dynamic matcher.
  installStentHooks()
  reg(patchA)
  reg(patchB)
  const mod = await import(fixture.href)
  check('registered add(2,3)', mod.add(2, 3), 23)
  check('registered greet(world)', mod.greet('world'), 'hello WORLD')
} else if (scenario === 'disposeFirst') {
  // A patch omitted from the live registry is absent from the first load.
  installStentHooks()
  reg(patchB)
  const mod = await import(fixture.href)
  check('after disposeA add(2,3)', mod.add(2, 3), 5)
  check('after disposeA greet(world)', mod.greet('world'), 'hello WORLD')
} else if (scenario === 'registeredCjs') {
  // The same single matcher handles plain-require CommonJS modules.
  installStentHooks()
  reg(cjsPatchA)
  reg(cjsPatchB)
  const mod = require(cjsFixture.pathname)
  check('registered cjs add(2,3)', mod.add(2, 3), 23)
  check('registered cjs greet(world)', mod.greet('world'), 'hello WORLD')
} else if (scenario === 'disposeFirstCjs') {
  installStentHooks()
  reg(cjsPatchB)
  const mod = require(cjsFixture.pathname)
  check('after disposeA cjs add(2,3)', mod.add(2, 3), 5)
  check('after disposeA cjs greet(world)', mod.greet('world'), 'hello WORLD')
} else if (scenario === 'stackedGreet') {
  // One dynamic matcher orders patches by priority, so the higher-priority
  // handler runs first.
  const greetA = {
    id: 'multi/greet-a',
    target: { ...target, functionQuery: { functionName: 'greet', kind: 'Sync' } },
    operation: 'before',
    priority: 10,
    handler(call) {
      call.arguments[0] = `${call.arguments[0]}A`
    },
  }
  const greetB = {
    id: 'multi/greet-b',
    target: { ...target, functionQuery: { functionName: 'greet', kind: 'Sync' } },
    operation: 'before',
    priority: 0,
    handler(call) {
      call.arguments[0] = `${call.arguments[0]}B`
    },
  }
  installStentHooks()
  reg(greetA)
  reg(greetB)
  const mod = await import(fixture.href)
  check('stacked greet(world)', mod.greet('world'), 'hello worldAB')
} else {
  throw new Error(`unknown scenario ${scenario}`)
}
