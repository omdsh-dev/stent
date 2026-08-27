/**
 * Runtime browser-bundle serving for Stent: serve a browser bundle with a Stent
 * transform applied, through the webserver's exact route table — the runtime
 * counterpart of {@link createBrowserTransform} for compositions whose target
 * bundle cannot be transformed at build time.
 *
 * The exact route outranks the module host's `/plugins` prefix (the exact table
 * wins before longest-prefix), so one package can own a single bundle path
 * without a route conflict. The served bytes are cached per source content;
 * only GET/HEAD are served (405 otherwise); an unreadable bundle is 404; a
 * transform that matches nothing or fails is loud by default (500 naming the
 * patch id) and serves the raw bundle only with `fallback: 'raw'`.
 *
 * @module @oh-my-dsh/stent/browser/internal-serve
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { createBrowserTransform } from '../transform/browser.ts'
import type { TransformOutput } from '../transform/browser.ts'
import { resolvePackageIdentity } from '../transform/identity.ts'
import type { StentPatchStub } from '../types.ts'

/** Options for {@link serveBrowserTransform}. */
export interface ServeBrowserTransformOptions {
  /**
   * Exact webserver path serving the transformed bundle (e.g.
   * `/plugins/@example/client-ui-conversation/client.js`).
   */
  route: string
  /**
   * Static patch descriptors whose targets select the rewrites. Every patch
   * must resolve to the SAME bundle file (same `module` and `filePath` — the
   * route serves one file), and the patches stack on that file exactly like
   * Node-side patches: ascending priority wraps outermost, equal priorities
   * keep registration order. Pass an array even when there is one patch.
   */
  patches: readonly StentPatchStub[]
  /**
   * Degradation when the transform matches nothing or fails: `'error'`
   * (default) fails the request loud with a 500 naming the patch id; `'raw'`
   * serves the bundle untouched (the app keeps working, the feature degrades).
   */
  fallback?: 'raw' | 'error'
}

/** Error marking an unreadable target bundle (answered as 404). */
class BundleUnreadableError extends Error {
  constructor() {
    super('stent: serveBrowserTransform bundle file unreadable')
    this.name = 'BundleUnreadableError'
  }
}

/**
 * Serve a browser bundle with one or more Stent transforms applied, through an
 * exact webserver route owned by the calling fiber.
 *
 * The route is registered as a fiber effect: disposing the fiber removes it.
 * The returned disposer removes it immediately (idempotent with the fiber
 * cleanup). The bundle path is resolved from the patches' `module` package
 * through the Loader composition anchor (`ctx.baseUrl`), not through Stent's
 * own dependency tree; the transforms and matcher are built once at
 * registration, and the served bytes are cached per source content.
 *
 * @param ctx - The Host context providing the webserver and composition base
 *   URL.
 * @param options - Route, patches, and degradation policy.
 * @returns A disposer removing the route.
 * @throws When the context has no `webServer` service or composition base URL,
 *   the target package cannot resolve, a descriptor is malformed, or the
 *   patches do not all target the same bundle file.
 */
export function serveBrowserTransform(
  ctx: Context,
  options: ServeBrowserTransformOptions,
): () => void {
  const httpServer = ctx.get('webServer') as
    | {
        register(route: {
          kind: 'exact'
          path: string
          handler: (req: IncomingMessage, res: ServerResponse) => void
        }): () => void
      }
    | undefined
  if (httpServer === undefined) {
    throw new Error(
      'stent: serveBrowserTransform requires the webServer service on the context',
    )
  }
  const fallback = options.fallback ?? 'error'
  const patches = [...options.patches]
  if (patches.length === 0) {
    throw new Error('stent: serveBrowserTransform requires at least one patch')
  }
  // Every patch must rewrite the SAME file the route serves: the bundle
  // path comes from the shared module + filePath, so a divergent target
  // would silently never bind. Fail loud at registration instead.
  const filePath = patches[0]?.target.filePath
  if (filePath === undefined || filePath instanceof RegExp) {
    throw new Error(
      'stent: serveBrowserTransform needs a concrete filePath (RegExp or filePaths cannot name a file to read)',
    )
  }
  const moduleName = patches[0]?.target.module
  for (const patch of patches) {
    if (
      patch.target.module !== moduleName
      || patch.target.filePath !== filePath
    ) {
      throw new Error(
        'stent: serveBrowserTransform patches must all target the same file '
          + `(${moduleName} ${filePath}); ${patch.id} targets ${patch.target.module} ${String(patch.target.filePath)}`,
      )
    }
  }
  const patchIds = [...new Set(patches.map((patch) => patch.id))]
  // The target is a sibling in the assembled composition, not a dependency of
  // Stent itself. Resolve through the Loader's config-tree anchor, whose
  // package manifest owns the composed plugin dependencies.
  if (ctx.baseUrl === undefined) {
    throw new Error(
      'stent: serveBrowserTransform requires ctx.baseUrl to resolve the target package from the composition',
    )
  }
  const require = createRequire(ctx.baseUrl)
  const pkgDir = dirname(require.resolve(`${moduleName}/package.json`))
  const bundlePath = join(pkgDir, filePath)
  // Validation and matcher construction happen once: a malformed descriptor
  // fails at registration, and every request reuses the same matcher.
  const transform = createBrowserTransform({
    patches,
    resolve: resolvePackageIdentity,
  })
  let cached: { source: string; code: string } | undefined

  /** The bytes to serve: the transformed bundle, cached per source content. */
  const bundleCode = (): string => {
    const path = bundlePath
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      throw new BundleUnreadableError()
    }
    if (cached !== undefined && cached.source === source) {
      return cached.code
    }
    // The upstream transformer throws when the selector finds no injection
    // points — its miss signal, like a null return for a non-matching file.
    let output: TransformOutput | null
    try {
      output = transform(source, path)
    } catch {
      output = null
    }
    // A patch is bound when its id appears in the output's binding reports;
    // any patch that rewrote nothing is a misconfiguration (wrong launch
    // form or moved function) that must not ship silently as an inert
    // bundle — even when the other patches bound.
    const bound = new Set(
      (output?.bindings ?? []).map((record) => record.patchId),
    )
    const missing = patchIds.filter((id) => !bound.has(id))
    if (output === null || missing.length > 0) {
      if (fallback === 'raw') {
        cached = { source, code: source }
        return source
      }
      throw new Error(
        `stent: serveBrowserTransform patch(es) ${missing.join(', ')} rewrote nothing in `
          + `${moduleName} ${filePath}; `
          + 'the selector may miss the function or the file may be the wrong launch form',
      )
    }
    cached = { source, code: output.code }
    return output.code
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    // Compute the body before writing headers: a failure must answer with
    // its own status, never after 200 was already sent.
    let body: string
    try {
      body = bundleCode()
    } catch (error) {
      if (error instanceof BundleUnreadableError) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(500)
      res.end(String(error instanceof Error ? error.message : error))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(body)
  }

  const route = { kind: 'exact' as const, path: options.route, handler }
  let removeRoute: (() => void) | undefined
  ctx.effect(() => {
    removeRoute = httpServer.register(route)
    return () => {
      removeRoute?.()
    }
  }, `stent:serveBrowserTransform(${options.route})`)
  return () => {
    removeRoute?.()
  }
}
