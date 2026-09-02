/**
 * Stent load-time transformation proof: every case runs in a fresh child
 * process because the synchronous module hooks cannot be unregistered and the
 * transformed module cache must not leak between cases. A table row is one
 * child case: the `it` title, then every stdout line the child must print.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** One child case: its `it` title followed by the stdout lines it must print. */
type ChildCase = readonly [title: string, ...expected: string[]]

/** One expanded row: the child case to run and the stdout lines it promises. */
interface ChildRun {
  readonly name: string
  readonly expected: readonly string[]
}

/** Child exit status for a completed run. */
const EXIT_SUCCESS = 0

const runner = fileURLToPath(new URL('child-runner.mjs', import.meta.url))

/** Run one Stent child case and return its stdout. */
function runCase(name: string): string {
  /* Tsconfig (whose paths lack these packages); children must resolve
     against this repo's own tsconfig so source-mode imports stay on src. */
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
  ).toBe(EXIT_SUCCESS)
  return result.stdout
}

/** Expand a case table into `[title, run]` rows: `it.each` names them by `%s`. */
function rowsOf(
  table: Readonly<Record<string, ChildCase>>,
): readonly [string, ChildRun][] {
  const rows: [string, ChildRun][] = []
  for (const [name, [title, ...expected]] of Object.entries(table)) {
    rows.push([title, { name, expected }])
  }
  return rows
}

/** Run one expanded row and assert every stdout line it promises. */
function checkRun(run: ChildRun): void {
  const out = runCase(run.name)
  for (const line of run.expected) {
    expect(out).toContain(line)
  }
}

const TRANSFORM_CASES: Readonly<Record<string, ChildCase>> = {
  installGuard: [
    'rejects calls with legacy installation arguments and accepts installStentHooks()',
    'PASS installGuard rejects every call with arguments: 3',
    'PASS installGuard explains the no-argument form: true',
    'PASS installGuard accepts installStentHooks: "function"',
    'PASS installGuard rejects duplicate active installation: true',
  ],
  dynamicBefore: [
    'adds plugin-registered metadata before a target module is loaded',
    'PASS dynamicBefore add(2,3): 23',
  ],
  dynamicLoaded: [
    'retransforms an already-loaded target after dynamic registration',
    'PASS dynamicLoaded original add(2,3): 5',
    'PASS dynamicLoaded patched add(2,3): 23',
    'PASS dynamicLoaded bindings: 1',
  ],
  dynamicBurst: [
    'coalesces rapid runtime registration and removal changes',
    'PASS dynamicBurst final patch after register/remove burst: 203',
    'PASS dynamicBurst original after removal burst: 5',
  ],
  workspaceIdentity: [
    'transforms a workspace package reached at its real path (no node_modules boundary)',
    'PASS workspaceIdentity add(2,3): 23',
  ],
  before: [
    'before rewrites arguments before the original body',
    'PASS before add(2,3): 23',
  ],
  after: [
    'after rewrites the successful result',
    'PASS after greet(world): "HELLO WORLD"',
  ],
  around: [
    'around can veto the original body or delegate',
    'PASS around add(99,1): "vetoed"',
    'PASS around add(1,2): 3',
  ],
  replace: [
    'replace owns the call on a class method',
    'PASS replace Calc.multiply(5): 5000',
  ],
  afterAsync: [
    'after rewrites async results after settlement',
    'PASS afterAsync fetchCount(ab): "COUNT:2"',
  ],
  afterMutate: [
    'keeps the result when a sync after handler mutates in place',
    'PASS afterMutate greet(world): "HELLO WORLD"',
  ],
}

const ASYNC_DYNAMIC_CASES: Readonly<Record<string, ChildCase>> = {
  afterAsyncMutate: [
    'keeps the settled value when an async after handler mutates in place',
    'PASS afterAsyncMutate fetchCount(ab): "COUNT:2"',
  ],
  asyncAwait: [
    'transforms async functions whose body awaits',
    'PASS asyncAwait withAwait(2): 50',
  ],
  generator: [
    'transforms generator functions with preserved iteration semantics',
    'PASS generator untouched counter(3): "[0,1,2]"',
    'PASS generator patched counter(3): "[0,1,2,3,4,5]"',
  ],
  asyncGenerator: [
    'transforms async generator functions with preserved iteration semantics',
    'PASS asyncGenerator patched asyncCounter(3): "[0,1,2,3,4,5]"',
  ],
  arrow: [
    'transforms arrow functions with plain identifier parameters',
    'PASS arrow double(2): 40',
  ],
  arrowRest: [
    'transforms arrow functions with rest parameters',
    'PASS arrowRest sumRest(1,2,3): 15',
  ],
  arrowDefault: [
    'transforms arrow functions with default parameters',
    'PASS arrowDefault withDefault(2): 30',
    'PASS arrowDefault withDefault(2,3): 23',
  ],
  arrowDestructure: [
    'transforms arrow functions with destructuring parameters',
    'PASS arrowDestructure pickName: "z:t:a:2"',
  ],
  arrowOuterArgs: [
    'preserves an arrow body referencing the enclosing arguments object',
    'PASS arrowOuterArgs callOuterArgs(7): "140"',
  ],
  priorityOrder: [
    'orders per-function handlers by priority, higher first',
    'PASS priority order add(2,3): "high,low"',
  ],
  priorityStable: [
    'keeps installation order for equal priorities',
    'PASS priority stable add(2,3): "second,first"',
  ],
  collide: [
    'handles arrow parameters that collide with injected names',
    'PASS collide param (2): 5',
  ],
  noBridge: [
    'falls back to the original body when the bridge is absent',
    'PASS noBridge add(2,3) falls back: 5',
  ],
  dynamicRemove: [
    'removes dynamic instrumentation from an already-loaded target',
    'PASS dynamicRemove patched add(2,3): 23',
    'PASS dynamicRemove original add(2,3): 5',
  ],
}

const CACHE_CASES: Readonly<Record<string, ChildCase>> = {
  dynamicRequired: [
    'checks required flags from the dynamic runtime registry',
    'PASS dynamicRequired no throw: ""',
    'PASS dynamicRequired bindings: 1',
  ],
  dynamicCjs: [
    'retransforms an already-loaded CommonJS target after dynamic registration',
    'PASS dynamicCjs original add(2,3): 5',
    'PASS dynamicCjs patched add(2,3): 23',
  ],
  cjs: [
    'transforms CommonJS modules reached through require()',
    'PASS cjs baseline add(2,3): 5',
    'PASS cjs patched add(2,3): 23',
  ],
  retransform: [
    're-transforms an already-evaluated CommonJS module (HMR invalidation)',
    'PASS retransform v1 add(2,3): 23',
    'PASS retransform cached add(2,3): 5',
    'PASS retransform reloaded add(2,3): 203',
  ],
  retransformEsm: [
    're-transforms an already-evaluated ESM module (HMR invalidation)',
    'PASS retransformEsm v1 add(2,3): 23',
    'PASS retransformEsm cached add(2,3): 5',
    'PASS retransformEsm reloaded add(2,3): 203',
  ],
  retransformEsmRollback: [
    'restores the previous instance when an ESM re-import fails',
    'PASS retransformEsmRollback initial value: 1',
    'PASS retransformEsmRollback re-import fails: true',
    'PASS retransformEsmRollback restores cached instance: true',
  ],
}

const BINDING_CASES: Readonly<Record<string, ChildCase>> = {
  retransformCjsDual: [
    'invalidates both the require cache and the ESM load cache for CommonJS',
    'PASS retransformCjsDual shared instance: true',
    'PASS retransformCjsDual v1 add(2,3): 23',
    'PASS retransformCjsDual reloaded add(2,3): 203',
    'PASS retransformCjsDual old instance detached: true',
    'PASS retransformCjsDual esm re-import shares reload: true',
    'PASS retransformCjsDual esm add(2,3): 203',
  ],
  bindingsReported: [
    'records load-time bindings for the files a transform actually rewrote',
    'PASS bindingsReported one record: 1',
    'PASS bindingsReported module: "stent-target-fixture"',
    'PASS bindingsReported file: "index.mjs"',
    'PASS bindingsReported nodes: 1',
    'PASS bindingsReported list() summary: 1',
  ],
  requiredHit: [
    'passes the post-boot check when a required patch bound',
    'PASS requiredHit no throw: ""',
    'PASS requiredHit bindings recorded: 1',
  ],
  requiredMiss: [
    'fails loud naming the patch id when a required patch bound nothing',
    'PASS requiredMiss throws: true',
    'PASS requiredMiss mentions target: true',
    'PASS requiredMiss zero bindings: 0',
  ],
  requiredRegExp: [
    'lets a RegExp filePath cover several launch forms under one patch id',
    'PASS requiredRegExp no throw: ""',
    'PASS requiredRegExp bindings recorded: 1',
  ],
  filePathsDual: [
    'expands filePaths into one instrumentation per entry under one patch id',
    'PASS filePathsDual index patched: 23',
    'PASS filePathsDual lib patched: 23',
    'PASS filePathsDual two records: 2',
    'PASS filePathsDual files: "index.mjs,lib.js"',
  ],
}

describe('stent load-time transformation (child processes)', () => {
  it.each(rowsOf(TRANSFORM_CASES))('%s', { timeout: 60_000 }, (_title, run) => {
    expect.hasAssertions()
    checkRun(run)
  })
})

describe('stent load-time async and dynamic cases', () => {
  it.each(rowsOf(ASYNC_DYNAMIC_CASES))(
    '%s',
    { timeout: 60_000 },
    (_title, run) => {
      expect.hasAssertions()
      checkRun(run)
    },
  )
})

describe('stent load-time cache and required cases', () => {
  it.each(rowsOf(CACHE_CASES))('%s', { timeout: 60_000 }, (_title, run) => {
    expect.hasAssertions()
    checkRun(run)
  })
})

describe('stent load-time binding requirements', () => {
  it.each(rowsOf(BINDING_CASES))('%s', { timeout: 60_000 }, (_title, run) => {
    expect.hasAssertions()
    checkRun(run)
  })
})
