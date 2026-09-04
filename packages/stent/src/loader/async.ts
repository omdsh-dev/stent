import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import type { MessagePort } from 'node:worker_threads'

import { serializeInstrumentation } from '#src/transform/wire'
import type { StentBindingReport } from '#src/types'

import type { LoaderHost, LoaderState } from './types.ts'

/** Default time to wait for the loader thread to acknowledge a flush. */
const DEFAULT_FLUSH_TIMEOUT_MS = 200
/** Index of the first pending flush waiter. */
const FIRST_WAITER_INDEX = 0

/** Mutable module state owned by the loader-thread installation. */
interface AsyncHookState {
  installed: boolean
  configPath: string | undefined
  bindingPort: MessagePort | undefined
  host: LoaderHost | undefined
}

/** One installed loader state as published to the loader thread. */
interface AsyncStateSnapshot {
  readonly active: boolean
  readonly instrumentations: readonly ReturnType<
    typeof serializeInstrumentation
  >[]
}

const asyncState: AsyncHookState = {
  installed: false,
  configPath: undefined,
  bindingPort: undefined,
  host: undefined,
}
const flushWaiters: (() => void)[] = []

/** Remove the published config file when this process exits. */
function scheduleAsyncConfigCleanup(configPath: string): void {
  process.once('exit', () => {
    try {
      unlinkSync(configPath)
    } catch {
      // The file may already have been removed.
    }
  })
}

/** Whether a value is a plain object whose properties can be inspected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return true
}

/** Whether the loader thread acknowledged the pending flush request. */
function isFlushDoneMessage(message: unknown): boolean {
  if (!isRecord(message)) {
    return false
  }
  const { type } = message
  return type === 'flush-done'
}

/** Release every waiter registered for the pending flush request. */
function resolveFlushWaiters(): void {
  const waiters = flushWaiters.splice(FIRST_WAITER_INDEX)
  for (const resolve of waiters) {
    resolve()
  }
}

/** Validate one binding report posted by the loader thread. */
function bindingReportOf(value: unknown): StentBindingReport | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { patchId, module, file, nodes } = value
  if (
    typeof patchId !== 'string'
    || typeof module !== 'string'
    || typeof file !== 'string'
    || typeof nodes !== 'number'
  ) {
    return undefined
  }
  return { patchId, module, file, nodes }
}

/** Record one binding report in the runtime registry. */
function recordBinding(value: unknown): void {
  const report = bindingReportOf(value)
  const { host } = asyncState
  if (report === undefined || host === undefined) {
    return
  }
  host.recordBindings(report.patchId, [
    { module: report.module, file: report.file, nodes: report.nodes },
  ])
}

/** Dispatch one message received from the loader thread. */
function handleBindingMessage(message: unknown): void {
  if (isFlushDoneMessage(message)) {
    resolveFlushWaiters()
    return
  }
  if (!Array.isArray(message)) {
    return
  }
  for (const record of message) {
    recordBinding(record)
  }
}

/** Choose the config path once and schedule its removal. */
function ensureAsyncConfigPath(): void {
  if (asyncState.configPath !== undefined) {
    return
  }
  const configPath = nodePath.join(tmpdir(), `stent-config-${process.pid}.json`)
  asyncState.configPath = configPath
  scheduleAsyncConfigCleanup(configPath)
}

/** Whether this module was loaded from its own directory rather than a bundle. */
function isDirectLoaderEntry(baseUrl: string): boolean {
  return (
    baseUrl.endsWith('/loader/loader.js')
    || baseUrl.endsWith('/loader/loader.ts')
  )
}

/** Resolve the hook entry module the loader thread registers. */
function hookEntryUrl(baseUrl: string): URL {
  if (!isDirectLoaderEntry(baseUrl)) {
    return new URL('loader/hook-entry.js', baseUrl)
  }
  if (baseUrl.endsWith('.ts')) {
    return new URL('hook-entry.ts', baseUrl)
  }
  return new URL('hook-entry.js', baseUrl)
}

/** Install the loader-thread hooks used when synchronous hooks are unavailable. */
function installAsyncHooks(baseUrl: string, host: LoaderHost): void {
  asyncState.host = host
  ensureAsyncConfigPath()
  if (asyncState.installed) {
    return
  }
  asyncState.installed = true
  const channel = new MessageChannel()
  asyncState.bindingPort = channel.port1
  channel.port1.on('message', handleBindingMessage)
  channel.port1.unref()
  register(hookEntryUrl(baseUrl).href, baseUrl, {
    data: { configPath: asyncState.configPath, port: channel.port2 },
    transferList: [channel.port2],
  })
}

/** Wait for binding reports posted by the loader thread to reach this thread. */
async function flushBindingReports(
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const { bindingPort } = asyncState
  if (bindingPort === undefined) {
    return
  }
  /* The settled value reports whether the loader thread acknowledged the
     flush before the timeout; callers only await the completion itself. */
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => {
    resolve(false)
  }, timeoutMs)
  flushWaiters.push(() => {
    clearTimeout(timer)
    resolve(true)
  })
  bindingPort.postMessage({ type: 'flush' }, [])
  await promise
}

/** Snapshot every installed loader state for the loader thread. */
function snapshotStates(states: readonly LoaderState[]): AsyncStateSnapshot[] {
  const snapshots: AsyncStateSnapshot[] = []
  for (const state of states) {
    snapshots.push({
      active: state.active,
      instrumentations: state.instrumentations.map(serializeInstrumentation),
    })
  }
  return snapshots
}

/** Write the active matcher snapshots consumed by the loader thread. */
function writeAsyncConfig(): void {
  const { configPath } = asyncState
  if (configPath === undefined) {
    return
  }
  const nextPath = `${configPath}.next`
  const states = asyncState.host?.getStates() ?? []
  writeFileSync(nextPath, JSON.stringify(snapshotStates(states)))
  renameSync(nextPath, configPath)
}

export { flushBindingReports, installAsyncHooks, writeAsyncConfig }
