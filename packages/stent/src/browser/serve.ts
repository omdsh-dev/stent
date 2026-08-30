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
interface ServeBrowserTransformOptions {
  /**
   * Exact webserver path serving the transformed bundle (e.g.
   * `/plugins/@example/client-ui-conversation/client.js`).
   */
  route: string
  /**
   * Static patch descriptors whose targets select the rewrites. Every patch
   * must resolve to the SAME bundle file (same `module` and `filePath` — the
   * route serves one file), and the patches stack on that file exactly like
   * Node-side patches: ascending priority wraps outermost, while this static
   * patch array preserves supplied order for equal priorities. Node dynamic
   * snapshots sort equal-priority ids. Pass an array even when there is one
   * patch.
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
 * registration, and the served bytes are cached per source content. Each call
 * owns one exact route; callers must aggregate descriptors to avoid duplicate
 * route registration when several plugins target the same bundle.
 *
 * @param ctx - The Host context providing the webserver and composition base
 *   URL.
 * @param options - Route, patches, and degradation policy.
 * @returns A disposer removing the route.
 * @throws When the context has no `webServer` service or composition base URL,
 *   the target package cannot resolve, a descriptor is malformed, or the
 *   patches do not all target the same bundle file.
 */
function serveBrowserTransform(
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
  const firstPatch = patches.at(0)
  if (firstPatch === undefined) {
    throw new Error('stent: serveBrowserTransform requires at least one patch')
  }
  // Every patch must rewrite the SAME file the route serves: the bundle
  // path comes from the shared module + filePath, so a divergent target
  // would silently never bind. Fail loud at registration instead.
  const filePath = firstPatch.target.filePath
  if (filePath === undefined || filePath instanceof RegExp) {
    throw new Error(
      'stent: serveBrowserTransform needs a concrete filePath (RegExp or filePaths cannot name a file to read)',
    )
  }
  const moduleName = firstPatch.target.module
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

  const bundleCode = createBundleCode(
    bundlePath,
    transform,
    patchIds,
    fallback,
    moduleName,
    filePath,
  )

  const handler = createBundleHandler(bundleCode)

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

type BundleTransform = (code: string, id: string) => TransformOutput | null

type BundleCode = () => string

/** Build a cached bundle reader and transformer. */
function createBundleCode(
  bundlePath: string,
  transform: BundleTransform,
  patchIds: string[],
  fallback: 'raw' | 'error',
  moduleName: string,
  filePath: string,
): BundleCode {
  let cached: { source: string; code: string } | undefined
  return () => {
    let source: string
    try {
      source = readFileSync(bundlePath, 'utf8')
    } catch {
      throw new BundleUnreadableError()
    }
    if (cached !== undefined && cached.source === source) {
      return cached.code
    }
    let output: TransformOutput | null
    try {
      output = transform(source, bundlePath)
    } catch {
      output = null
    }
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
}

/** Create the HTTP handler for a transformed bundle route. */
function createBundleHandler(bundleCode: BundleCode) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
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
}

export type { ServeBrowserTransformOptions }
export { serveBrowserTransform }
