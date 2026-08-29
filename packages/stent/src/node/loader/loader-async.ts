import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessagePort } from 'node:worker_threads'

import { runtime } from '../../runtime.ts'
import { serializeInstrumentation } from '../../transform/wire.ts'
import type { StentBindingReport } from '../../types.ts'
import { states } from './loader-state.ts'

let asyncHooksInstalled = false
let asyncConfigPath: string | undefined
let asyncBindingPort: MessagePort | undefined
const flushWaiters: Array<() => void> = []

function scheduleAsyncConfigCleanup(path: string): void {
  process.once('exit', () => {
    try {
      unlinkSync(path)
    } catch {
      // The file may already have been removed.
    }
  })
}

/** Install the loader-thread hooks used when synchronous hooks are unavailable. */
export function installAsyncHooks(baseUrl: string): void {
  if (asyncConfigPath === undefined) {
    asyncConfigPath = join(tmpdir(), `stent-config-${process.pid}.json`)
    scheduleAsyncConfigCleanup(asyncConfigPath)
  }
  if (asyncHooksInstalled) {
    return
  }
  asyncHooksInstalled = true
  const channel = new MessageChannel()
  const port = channel.port1
  asyncBindingPort = port
  port.on('message', (message: unknown) => {
    if (
      typeof message === 'object'
      && message !== null
      && (message as { type?: string }).type === 'flush-done'
    ) {
      const waiters = flushWaiters.splice(0)
      for (const resolve of waiters) {
        resolve()
      }
      return
    }
    if (!Array.isArray(message)) {
      return
    }
    for (const record of message) {
      if (typeof record !== 'object' || record === null) {
        continue
      }
      const report = record as Partial<StentBindingReport>
      if (
        typeof report.patchId === 'string'
        && typeof report.module === 'string'
        && typeof report.file === 'string'
        && typeof report.nodes === 'number'
      ) {
        runtime.recordBindings(report.patchId, [
          { module: report.module, file: report.file, nodes: report.nodes },
        ])
      }
    }
  })
  port.unref()
  const directNodeEntry =
    baseUrl.endsWith('/node/loader/loader.js')
    || baseUrl.endsWith('/node/loader/loader.ts')
  const hookEntry = directNodeEntry
    ? new URL(
        baseUrl.endsWith('.ts') ? '../hook-entry.ts' : '../hook-entry.js',
        baseUrl,
      )
    : new URL('./node/hook-entry.js', baseUrl)
  register(hookEntry.href, baseUrl, {
    data: { configPath: asyncConfigPath, port: channel.port2 },
    transferList: [channel.port2],
  })
}

/** Wait for binding reports posted by the loader thread to reach this thread. */
export async function flushBindingReports(timeoutMs = 200): Promise<void> {
  if (asyncBindingPort === undefined) {
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      const index = flushWaiters.indexOf(resolve)
      if (index >= 0) {
        flushWaiters.splice(index, 1)
      }
      resolve()
    }, timeoutMs)
    flushWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
    asyncBindingPort?.postMessage({ type: 'flush' })
  })
}

/** Write the active matcher snapshots consumed by the loader thread. */
export function writeAsyncConfig(): void {
  if (asyncConfigPath === undefined) {
    return
  }
  const nextPath = `${asyncConfigPath}.next`
  writeFileSync(
    nextPath,
    JSON.stringify(
      states.map((state) => ({
        active: state.active,
        instrumentations: state.instrumentations.map(serializeInstrumentation),
      })),
    ),
  )
  renameSync(nextPath, asyncConfigPath)
}
