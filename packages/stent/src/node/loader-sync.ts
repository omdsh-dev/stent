import { readFileSync } from 'node:fs'
import { Module, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolvePackageIdentity } from '../transform/identity.ts'
import {
  getStentTransformer,
  transformStentSource,
} from '../transform/matcher.ts'
import { flushBindings, states } from './loader-state.ts'
import type { CompileFn, LoaderState } from './loader-types.ts'

/** Register synchronous ESM and CJS load hooks for one installation. */
export function installSynchronousHooks(state: LoaderState): void {
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const resolved = nextResolve(specifier, context)
      if (!state.active) {
        return resolved
      }
      const identity = resolvePackageIdentity(resolved.url)
      if (identity === undefined) {
        return resolved
      }
      const transformer = getStentTransformer(
        state.matcher,
        identity.name,
        identity.version,
        identity.path,
      )
      if (transformer) {
        state.transformers.set(resolved.url, transformer)
      }
      return resolved
    },
    load: (url, context, nextLoad) => {
      const result = nextLoad(url, context)
      if (!state.active) {
        return result
      }
      const transformer = state.transformers.get(url)
      if (!transformer) {
        return result
      }
      const path = url.startsWith('file:') ? fileURLToPath(url) : url
      if (state.seen.has(path)) {
        return result
      }
      state.seen.add(path)
      try {
        const source = readSource(result, url)
        const moduleType = context.format === 'module' ? 'esm' : 'cjs'
        const transformed = transformStentSource(
          transformer,
          source,
          moduleType,
        )
        const identity = resolvePackageIdentity(path)
        if (identity !== undefined) {
          flushBindings(state, identity)
        }
        return { ...result, source: transformed.code, shortCircuit: true }
      } catch (error) {
        state.pending.clear()
        state.transformers.delete(url)
        throw new Error(`stent: failed to transform ${url}`, { cause: error })
      }
    },
  })
}

let compileWrapperInstalled = false

/** Install the process-wide CommonJS compile wrapper once. */
export function installCompileWrapper(): void {
  if (compileWrapperInstalled) {
    return
  }
  compileWrapperInstalled = true
  const modulePrototype = Module.prototype as unknown as Record<string, unknown>
  const compileKey = '_compile'
  const originalCompile = modulePrototype[compileKey] as CompileFn
  modulePrototype[compileKey] = function (
    this: Module,
    content: string,
    filename: string,
  ) {
    const identity = resolvePackageIdentity(filename)
    if (identity !== undefined) {
      for (const state of states) {
        if (!state.active) {
          continue
        }
        const transformer = getStentTransformer(
          state.matcher,
          identity.name,
          identity.version,
          identity.path,
        )
        if (!transformer || state.seen.has(filename)) {
          continue
        }
        state.seen.add(filename)
        try {
          content = transformStentSource(transformer, content, 'cjs').code
          flushBindings(state, identity)
        } catch (error) {
          state.pending.clear()
          state.seen.delete(filename)
          throw new Error(`stent: failed to transform ${filename}`, {
            cause: error,
          })
        }
      }
    }
    return originalCompile.call(this, content, filename)
  }
}

function readSource(
  result: {
    source?: string | ArrayBuffer | NodeJS.TypedArray | null | undefined
  },
  url: string,
): string {
  if (typeof result.source === 'string') {
    return result.source
  }
  if (result.source instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(result.source)).toString('utf8')
  }
  if (result.source != null) {
    return Buffer.from(result.source as Uint8Array).toString('utf8')
  }
  return readFileSync(fileURLToPath(url), 'utf8')
}
