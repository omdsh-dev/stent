import { isStentActive, runtime } from '@oh-my-dsh/stent'

runtime.register({
  id: 'preload/dynamic',
  target: { module: 'stent-target-fixture', versionRange: '^1.0.0', filePath: 'index.mjs', functionQuery: { functionName: 'add', kind: 'Sync' } },
  operation: 'before', priority: 0, enabled: false,
})
runtime.enable('preload/dynamic', call => { call.arguments[0] *= 10 })
const { add } = await import('../../packages/stent/tests/fixtures/node_modules/stent-target-fixture/index.mjs')
const result = add(2, 3)
console.log('DIRECT-PRELOAD active=' + isStentActive() + ' result=' + result)
process.exitCode = result === (isStentActive() ? 23 : 5) ? 0 : 1
