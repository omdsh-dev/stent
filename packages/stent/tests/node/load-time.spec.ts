import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('./child-runner.mjs', import.meta.url))

/** Run one Stent child case and return its stdout. */
function runCase(name: string): string {
  // tsconfig (whose paths lack these packages); children must resolve
  // against this repo's own tsconfig so source-mode imports stay on src.
  const childEnv = { ...process.env }
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', runner, name],
    {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      encoding: 'utf8',
      env: childEnv,
    },
  )
  expect(
    result.status,
    `child ${name} exited 0\n${result.stdout}\n${result.stderr}`,
  ).toBe(0)
  return result.stdout
}

describe('stent load-time transformation (child processes)', () => {
  it('rejects calls with legacy installation arguments and accepts installStentHooks()', () => {
    const out = runCase('installGuard')
    expect(out).toContain(
      'PASS installGuard rejects every call with arguments: 3',
    )
    expect(out).toContain(
      'PASS installGuard explains the no-argument form: true',
    )
    expect(out).toContain(
      'PASS installGuard accepts installStentHooks: "function"',
    )
    expect(out).toContain(
      'PASS installGuard rejects duplicate active installation: true',
    )
  })

  it('adds plugin-registered metadata before a target module is loaded', () => {
    const out = runCase('dynamicBefore')
    expect(out).toContain('PASS dynamicBefore add(2,3): 23')
  })

  it('retransforms an already-loaded target after dynamic registration', () => {
    const out = runCase('dynamicLoaded')
    expect(out).toContain('PASS dynamicLoaded original add(2,3): 5')
    expect(out).toContain('PASS dynamicLoaded patched add(2,3): 23')
    expect(out).toContain('PASS dynamicLoaded bindings: 1')
  })

  it('coalesces rapid runtime registration and removal changes', () => {
    const out = runCase('dynamicBurst')
    expect(out).toContain(
      'PASS dynamicBurst final patch after register/remove burst: 203',
    )
    expect(out).toContain('PASS dynamicBurst original after removal burst: 5')
  })

  it('transforms a workspace package reached at its real path (no node_modules boundary)', () => {
    const out = runCase('workspaceIdentity')
    expect(out).toContain('PASS workspaceIdentity add(2,3): 23')
  })

  it('before rewrites arguments before the original body', () => {
    const out = runCase('before')
    expect(out).toContain('PASS before add(2,3): 23')
  })

  it('after rewrites the successful result', () => {
    const out = runCase('after')
    expect(out).toContain('PASS after greet(world): "HELLO WORLD"')
  })

  it('around can veto the original body or delegate', () => {
    const out = runCase('around')
    expect(out).toContain('PASS around add(99,1): "vetoed"')
    expect(out).toContain('PASS around add(1,2): 3')
  })

  it('replace owns the call on a class method', () => {
    const out = runCase('replace')
    expect(out).toContain('PASS replace Calc.multiply(5): 5000')
  })

  it('after rewrites async results after settlement', () => {
    const out = runCase('afterAsync')
    expect(out).toContain('PASS afterAsync fetchCount(ab): "COUNT:2"')
  })

  it('keeps the result when a sync after handler mutates in place', () => {
    const out = runCase('afterMutate')
    expect(out).toContain('PASS afterMutate greet(world): "HELLO WORLD"')
  })

  it('keeps the settled value when an async after handler mutates in place', () => {
    const out = runCase('afterAsyncMutate')
    expect(out).toContain('PASS afterAsyncMutate fetchCount(ab): "COUNT:2"')
  })

  it('transforms async functions whose body awaits', () => {
    const out = runCase('asyncAwait')
    expect(out).toContain('PASS asyncAwait withAwait(2): 50')
  })

  it('transforms generator functions with preserved iteration semantics', () => {
    const out = runCase('generator')
    expect(out).toContain('PASS generator untouched counter(3): "[0,1,2]"')
    expect(out).toContain('PASS generator patched counter(3): "[0,1,2,3,4,5]"')
  })

  it('transforms async generator functions with preserved iteration semantics', () => {
    const out = runCase('asyncGenerator')
    expect(out).toContain(
      'PASS asyncGenerator patched asyncCounter(3): "[0,1,2,3,4,5]"',
    )
  })

  it('transforms arrow functions with plain identifier parameters', () => {
    const out = runCase('arrow')
    expect(out).toContain('PASS arrow double(2): 40')
  })

  it('transforms arrow functions with rest parameters', () => {
    const out = runCase('arrowRest')
    expect(out).toContain('PASS arrowRest sumRest(1,2,3): 15')
  })

  it('transforms arrow functions with default parameters', () => {
    const out = runCase('arrowDefault')
    expect(out).toContain('PASS arrowDefault withDefault(2): 30')
    expect(out).toContain('PASS arrowDefault withDefault(2,3): 23')
  })

  it('transforms arrow functions with destructuring parameters', () => {
    const out = runCase('arrowDestructure')
    expect(out).toContain('PASS arrowDestructure pickName: "z:t:a:2"')
  })

  it('preserves an arrow body referencing the enclosing arguments object', () => {
    const out = runCase('arrowOuterArgs')
    expect(out).toContain('PASS arrowOuterArgs callOuterArgs(7): "140"')
  })

  it('orders per-function handlers by priority, higher first', () => {
    const out = runCase('priorityOrder')
    expect(out).toContain('PASS priority order add(2,3): "high,low"')
  })

  it('keeps installation order for equal priorities', () => {
    const out = runCase('priorityStable')
    expect(out).toContain('PASS priority stable add(2,3): "second,first"')
  })

  it('handles arrow parameters that collide with injected names', () => {
    const out = runCase('collide')
    expect(out).toContain('PASS collide param (2): 5')
  })

  it('falls back to the original body when the bridge is absent', () => {
    const out = runCase('noBridge')
    expect(out).toContain('PASS noBridge add(2,3) falls back: 5')
  })

  it('removes dynamic instrumentation from an already-loaded target', () => {
    const out = runCase('dynamicRemove')
    expect(out).toContain('PASS dynamicRemove patched add(2,3): 23')
    expect(out).toContain('PASS dynamicRemove original add(2,3): 5')
  })
  it('checks required flags from the dynamic runtime registry', () => {
    const out = runCase('dynamicRequired')
    expect(out).toContain('PASS dynamicRequired no throw: ""')
    expect(out).toContain('PASS dynamicRequired bindings: 1')
  })
  it('retransforms an already-loaded CommonJS target after dynamic registration', () => {
    const out = runCase('dynamicCjs')
    expect(out).toContain('PASS dynamicCjs original add(2,3): 5')
    expect(out).toContain('PASS dynamicCjs patched add(2,3): 23')
  })

  it('transforms CommonJS modules reached through require()', () => {
    const out = runCase('cjs')
    expect(out).toContain('PASS cjs baseline add(2,3): 5')
    expect(out).toContain('PASS cjs patched add(2,3): 23')
  })

  it('re-transforms an already-evaluated CommonJS module (HMR invalidation)', () => {
    const out = runCase('retransform')
    expect(out).toContain('PASS retransform v1 add(2,3): 23')
    expect(out).toContain('PASS retransform cached add(2,3): 5')
    expect(out).toContain('PASS retransform reloaded add(2,3): 203')
  })

  it('re-transforms an already-evaluated ESM module (HMR invalidation)', () => {
    const out = runCase('retransformEsm')
    expect(out).toContain('PASS retransformEsm v1 add(2,3): 23')
    expect(out).toContain('PASS retransformEsm cached add(2,3): 5')
    expect(out).toContain('PASS retransformEsm reloaded add(2,3): 203')
  })

  it('restores the previous instance when an ESM re-import fails', () => {
    const out = runCase('retransformEsmRollback')
    expect(out).toContain('PASS retransformEsmRollback initial value: 1')
    expect(out).toContain('PASS retransformEsmRollback re-import fails: true')
    expect(out).toContain(
      'PASS retransformEsmRollback restores cached instance: true',
    )
  })

  it('invalidates both the require cache and the ESM load cache for CommonJS', () => {
    const out = runCase('retransformCjsDual')
    expect(out).toContain('PASS retransformCjsDual shared instance: true')
    expect(out).toContain('PASS retransformCjsDual v1 add(2,3): 23')
    expect(out).toContain('PASS retransformCjsDual reloaded add(2,3): 203')
    expect(out).toContain('PASS retransformCjsDual old instance detached: true')
    expect(out).toContain(
      'PASS retransformCjsDual esm re-import shares reload: true',
    )
    expect(out).toContain('PASS retransformCjsDual esm add(2,3): 203')
  })

  it('records load-time bindings for the files a transform actually rewrote', () => {
    const out = runCase('bindingsReported')
    expect(out).toContain('PASS bindingsReported one record: 1')
    expect(out).toContain(
      'PASS bindingsReported module: "stent-target-fixture"',
    )
    expect(out).toContain('PASS bindingsReported file: "index.mjs"')
    expect(out).toContain('PASS bindingsReported nodes: 1')
    expect(out).toContain('PASS bindingsReported list() summary: 1')
  })

  it('passes the post-boot check when a required patch bound', () => {
    const out = runCase('requiredHit')
    expect(out).toContain('PASS requiredHit no throw: ""')
    expect(out).toContain('PASS requiredHit bindings recorded: 1')
  })

  it('fails loud naming the patch id when a required patch bound nothing', () => {
    const out = runCase('requiredMiss')
    expect(out).toContain('PASS requiredMiss throws: true')
    expect(out).toContain('PASS requiredMiss mentions target: true')
    expect(out).toContain('PASS requiredMiss zero bindings: 0')
  })

  it('lets a RegExp filePath cover several launch forms under one patch id', () => {
    const out = runCase('requiredRegExp')
    expect(out).toContain('PASS requiredRegExp no throw: ""')
    expect(out).toContain('PASS requiredRegExp bindings recorded: 1')
  })

  it('expands filePaths into one instrumentation per entry under one patch id', () => {
    const out = runCase('filePathsDual')
    expect(out).toContain('PASS filePathsDual index patched: 23')
    expect(out).toContain('PASS filePathsDual lib patched: 23')
    expect(out).toContain('PASS filePathsDual two records: 2')
    expect(out).toContain('PASS filePathsDual files: "index.mjs,lib.js"')
  })
})
