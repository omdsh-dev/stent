/**
 * Entry module for a direct preload probe. Without the launcher capability, the
 * preload must remain inert even if a legacy STENT_CONFIG variable is present.
 */
import { add } from '../../packages/stent/tests/fixtures/node_modules/stent-target-fixture/index.mjs'
import { isStentDshLaunch, runtime } from '@oh-my-dsh/stent'

const bound = runtime.bindingsOf('preload/multiply-add').length
const result = add(2, 3)
console.log(`DIRECT-PRELOAD launch=${isStentDshLaunch()} bindings=${bound} add(2,3)=${result}`)
process.exit(!isStentDshLaunch() && bound === 0 && result === 5 ? 0 : 1)
