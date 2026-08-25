/**
 * Entry module for the Stent launcher. It runs the host CLI as
 * `node --import tsx/esm --import <Stent preload> bin.ts`
 * with STENT_CONFIG set, so by the time this file's imports evaluate,
 * the Stent loader hooks must already be installed.
 *
 * The static import below proves that ordering: it goes through the hook,
 * the binding report must be observable from this same process, and a handler
 * registered only afterwards still reaches calls made through the
 * transformed module.
 */
import { readFileSync } from 'node:fs'
import { add } from '../../packages/stent/tests/fixtures/node_modules/stent-target-fixture/index.mjs'
import { checkRequiredPatches, flushBindingReports, isStentDshLaunch, runtime } from '@oh-my-dsh/stent'

const configPath = process.env.STENT_CONFIG

if (configPath === undefined || configPath === '') {
  // No config: the preload must be inert — the host runs unmodified. The
  // fixture import above must have produced no bindings and no behavior
  // change.
  const bound = runtime.bindingsOf('preload/multiply-add').length
  const result = add(2, 3)
  console.log(`NO-CONFIG launch=${isStentDshLaunch()} bindings=${bound} add(2,3)=${result}`)
  process.exit(!isStentDshLaunch() && bound === 0 && result === 5 ? 0 : 1)
}

const [patch] = JSON.parse(readFileSync(configPath, 'utf8'))

// The async register() path delivers binding records over a message port;
// wait for them before the required-patch check (the production Host plugin
// runs the same check after boot, when the reports have landed).
await flushBindingReports(1000)
checkRequiredPatches([patch])

// No handler is registered yet: the transformed call publishes to the bridge
// and falls through to the original body.
const before = add(2, 3)

// Registering a handler after load still reaches the transformed call site.
runtime.register({ id: patch.id, target: patch.target, operation: patch.operation, priority: 0, enabled: false })
runtime.enable(patch.id, (call) => {
  call.arguments[0] = call.arguments[0] * 10
})
const after = add(2, 3)

console.log(`LAUNCH=${isStentDshLaunch()} BEFORE add(2,3)=${before} AFTER add(2,3)=${after}`)
process.exit(isStentDshLaunch() && before === 5 && after === 23 ? 0 : 1)
