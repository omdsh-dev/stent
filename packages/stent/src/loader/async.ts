import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import type { MessagePort } from 'node:worker_threads'

import { serializeInstrumentation } from '#src/transform/wire'
import type { StentBindingReport } from '#src/types'

import type { LoaderState } from './state.ts'
import type { LoaderHost } from './types.ts'

/** Default time to wait for the loader thread to acknowledge a flush. */
const DEFAULT_FLUSH_TIMEOUT_MS = 200
/** Index of the first pending flush waiter. */
const FIRST_WAITER_INDEX = 0
/** Sentinel for a waiter that has already been removed. */
const NOT_FOUND_INDEX = -1
/** Number of waiter entries removed at a time. */
const REMOVE_COUNT = 1

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

/** One installed loader state as published to the loader thread. */
interface AsyncStateSnapshot {
  readonly active: boolean
  readonly instrumentations: readonly ReturnType<
    typeof serializeInstrumentation
  >[]
}

/** Owns the async loader registration, channel, config path, and flush waiters. */
class AsyncLoaderController {
  #installed = false
  #configPath: string | undefined
  #bindingPort: MessagePort | undefined
  #host: LoaderHost | undefined
  readonly #flushWaiters: (() => void)[] = []

  public setHost(host: LoaderHost): void {
    this.#host = host
  }

  public get host(): LoaderHost | undefined {
    return this.#host
  }

  public get installed(): boolean {
    return this.#installed
  }

  public markInstalled(): void {
    this.#installed = true
  }

  public get configPath(): string | undefined {
    return this.#configPath
  }

  public ensureConfigPath(): string {
    if (this.#configPath === undefined) {
      this.#configPath = nodePath.join(
        tmpdir(),
        `stent-config-${process.pid}.json`,
      )
      scheduleAsyncConfigCleanup(this.#configPath)
    }
    return this.#configPath
  }

  public setBindingPort(port: MessagePort): void {
    this.#bindingPort = port
  }

  public get bindingPort(): MessagePort | undefined {
    return this.#bindingPort
  }

  public addFlushWaiter(resolve: () => void): () => void {
    this.#flushWaiters.push(resolve)
    return () => {
      const index = this.#flushWaiters.indexOf(resolve)
      if (index !== NOT_FOUND_INDEX) {
        this.#flushWaiters.splice(index, REMOVE_COUNT)
      }
    }
  }

  public deactivate(): void {
    const port = this.#bindingPort
    this.#bindingPort = undefined
    this.#host = undefined
    this.#installed = false
    port?.close()
    this.resolveFlushWaiters()
  }

  public resolveFlushWaiters(): void {
    const waiters = this.#flushWaiters.splice(FIRST_WAITER_INDEX)
    for (const resolve of waiters) {
      resolve()
    }
  }
}

const asyncController = new AsyncLoaderController()

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
  const { host } = asyncController
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
    asyncController.resolveFlushWaiters()
    return
  }
  if (!Array.isArray(message)) {
    return
  }
  for (const record of message) {
    recordBinding(record)
  }
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
  asyncController.setHost(host)
  asyncController.ensureConfigPath()
  if (asyncController.installed) {
    return
  }
  const channel = new MessageChannel()
  asyncController.setBindingPort(channel.port1)
  channel.port1.on('message', handleBindingMessage)
  channel.port1.unref()
  register(hookEntryUrl(baseUrl).href, baseUrl, {
    data: { configPath: asyncController.configPath, port: channel.port2 },
    transferList: [channel.port2],
  })
  asyncController.markInstalled()
}

/** Wait for binding reports posted by the loader thread to reach this thread. */
async function flushBindingReports(
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const { bindingPort } = asyncController
  if (bindingPort === undefined) {
    return
  }
  /* The settled value reports whether the loader thread acknowledged the
     flush before the timeout; callers only await the completion itself. */
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => {
    resolve(false)
  }, timeoutMs)
  const removeWaiter = asyncController.addFlushWaiter(() => {
    clearTimeout(timer)
    resolve(true)
  })
  try {
    bindingPort.postMessage({ type: 'flush' }, [])
    await promise
  } finally {
    removeWaiter()
  }
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
  const { configPath } = asyncController
  if (configPath === undefined) {
    return
  }
  const nextPath = `${configPath}.next`
  const states = asyncController.host?.getStates() ?? []
  writeFileSync(nextPath, JSON.stringify(snapshotStates(states)))
  renameSync(nextPath, configPath)
}

function deactivateAsyncHooks(): void {
  if (!asyncController.installed) {
    return
  }
  asyncController.deactivate()
}

export {
  AsyncLoaderController,
  deactivateAsyncHooks,
  flushBindingReports,
  installAsyncHooks,
  writeAsyncConfig,
}
