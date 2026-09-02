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
 * patch id), serving the raw bundle only with `fallback: 'raw'`.
 *
 * @module @oh-my-dsh/stent/browser/internal-serve
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { createBrowserTransform } from '#src/transform/browser'
import { resolvePackageIdentity } from '#src/transform/identity'
import type { StentPatchStub } from '#src/types'

const STATUS_OK = 200
const STATUS_NOT_FOUND = 404
const STATUS_METHOD_NOT_ALLOWED = 405
const STATUS_INTERNAL_ERROR = 500
const NO_UNBOUND_PATCHES = 0

/** Options for {@link serveBrowserTransform}. */
interface ServeBrowserTransformOptions {
  /**
   * Exact webserver path serving the transformed bundle (e.g.
   * `/plugins/@example/client-ui-conversation/client.js`).
   */
  readonly route: string
  /**
   * Static patch descriptors whose targets select the rewrites. Every patch
   * must resolve to the SAME bundle file (same `module` and `filePath` — the
   * route serves one file), and they stack on it exactly like Node-side
   * patches: ascending priority wraps outermost, while this static array
   * preserves supplied order for equal priorities (Node dynamic snapshots sort
   * equal-priority ids). Pass an array even for a single patch.
   */
  readonly patches: readonly StentPatchStub[]
  /**
   * Degradation when the transform matches nothing or fails: `'error'`
   * (default) fails the request loud with a 500 naming the patch id; `'raw'`
   * serves the bundle untouched (the app keeps working, the feature degrades).
   */
  readonly fallback?: 'raw' | 'error'
}

type BundleTransform = ReturnType<typeof createBrowserTransform>
type BundleCode = () => string
interface ExactRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void
}
interface WebServerService {
  readonly register: (route: ExactRoute) => () => void
}
interface BundleTarget {
  readonly moduleName: string
  readonly filePath: string
}
interface BundleCodeOptions {
  readonly bundlePath: string
  readonly transform: BundleTransform
  readonly patchIds: readonly string[]
  readonly fallback: 'raw' | 'error'
  readonly target: BundleTarget
}

/** Error marking an unreadable target bundle (answered as 404). */
class BundleUnreadableError extends Error {
  public constructor() {
    super('stent: serveBrowserTransform bundle file unreadable')
    this.name = 'BundleUnreadableError'
  }
}

function isWebServerService(value: unknown): value is WebServerService {
  return (
    typeof value === 'object'
    && value !== null
    && 'register' in value
    && typeof value.register === 'function'
  )
}

/**
 * Resolve the one file the route serves. Every patch must rewrite the SAME file
 * — the bundle path comes from the shared module and filePath, so a divergent
 * target would silently never bind. Fail loud at registration.
 */
function resolveBundleTarget(patches: readonly StentPatchStub[]): BundleTarget {
  const [firstPatch] = patches
  if (firstPatch === undefined) {
    throw new Error('stent: serveBrowserTransform requires at least one patch')
  }
  const { filePath } = firstPatch.target
  if (filePath === undefined || filePath instanceof RegExp) {
    throw new Error(
      'stent: serveBrowserTransform needs a concrete filePath (RegExp or filePaths cannot name a file to read)',
    )
  }
  const divergent = patches.find(
    (patch) =>
      patch.target.module !== firstPatch.target.module
      || patch.target.filePath !== filePath,
  )
  if (divergent !== undefined) {
    throw new Error(
      'stent: serveBrowserTransform patches must all target the same file '
        + `(${firstPatch.target.module} ${filePath}); ${divergent.id} targets ${divergent.target.module} ${String(divergent.target.filePath)}`,
    )
  }
  return { moduleName: firstPatch.target.module, filePath }
}

/**
 * Resolve the bundle file inside the composed target package: a sibling of the
 * assembled composition, not a dependency of Stent itself, so it resolves
 * through the Loader's config-tree anchor and its package manifest.
 */
function resolveBundlePath(ctx: Context, target: BundleTarget): string {
  if (ctx.baseUrl === undefined) {
    throw new Error(
      'stent: serveBrowserTransform requires ctx.baseUrl to resolve the target package from the composition',
    )
  }
  const require = createRequire(ctx.baseUrl)
  const manifest = require.resolve(`${target.moduleName}/package.json`)
  return path.join(path.dirname(manifest), target.filePath)
}

/** Read the target bundle, marking an unreadable file for the 404 answer. */
function readBundleSource(bundlePath: string): string {
  try {
    return readFileSync(bundlePath, 'utf8')
  } catch {
    throw new BundleUnreadableError()
  }
}

function runBundleTransform(
  options: BundleCodeOptions,
  source: string,
): NonNullable<ReturnType<BundleTransform>> | undefined {
  try {
    return options.transform(source, options.bundlePath) ?? undefined
  } catch {
    return undefined
  }
}

/** Transform the bundle source, applying the degradation policy on a miss. */
function transformBundle(options: BundleCodeOptions, source: string): string {
  const output = runBundleTransform(options, source)
  const bound = new Set((output?.bindings ?? []).map((rec) => rec.patchId))
  const missing = options.patchIds.filter((id) => !bound.has(id))
  if (output !== undefined && missing.length === NO_UNBOUND_PATCHES) {
    return output.code
  }
  if (options.fallback === 'raw') {
    return source
  }
  throw new Error(
    `stent: serveBrowserTransform patch(es) ${missing.join(', ')} rewrote nothing in `
      + `${options.target.moduleName} ${options.target.filePath}; `
      + 'the selector may miss the function or the file may be the wrong launch form',
  )
}

/** Build a cached bundle reader and transformer. */
function createBundleCode(options: BundleCodeOptions): BundleCode {
  const cache: { current?: { source: string; code: string } } = {}
  return (): string => {
    const source = readBundleSource(options.bundlePath)
    const { current } = cache
    if (current !== undefined && current.source === source) {
      return current.code
    }
    const code = transformBundle(options, source)
    cache.current = { source, code }
    return code
  }
}

/** Answer a bundle failure: an unreadable file is 404, anything else 500. */
function respondWithFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof BundleUnreadableError) {
    res.writeHead(STATUS_NOT_FOUND)
    res.end()
    return
  }
  res.writeHead(STATUS_INTERNAL_ERROR)
  if (error instanceof Error) {
    res.end(error.message)
    return
  }
  res.end(String(error))
}

/** Create the HTTP handler for a transformed bundle route. */
function createBundleHandler(bundleCode: BundleCode): ExactRoute['handler'] {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(STATUS_METHOD_NOT_ALLOWED)
      res.end()
      return
    }
    try {
      const code = bundleCode()
      res.writeHead(STATUS_OK, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(code)
    } catch (error) {
      respondWithFailure(res, error)
    }
  }
}

/**
 * Serve a browser bundle with one or more Stent transforms applied, through an
 * exact webserver route owned by the calling fiber.
 *
 * The route is a fiber effect: disposing the fiber removes it, and the returned
 * disposer removes it immediately (idempotent with the fiber cleanup). The
 * bundle path resolves from the patches' `module` package through the Loader
 * composition anchor (`ctx.baseUrl`), not through Stent's own dependency tree;
 * validation and matcher construction happen once at registration, so every
 * request reuses the same matcher over bytes cached per source content. Each
 * call owns one exact route.
 *
 * @param ctx - Host context providing the webserver and composition base URL.
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
  const httpServer: unknown = ctx.get('webServer')
  if (!isWebServerService(httpServer)) {
    throw new Error(
      'stent: serveBrowserTransform requires the webServer service on the context',
    )
  }
  const patches = [...options.patches]
  const target = resolveBundleTarget(patches)
  const bundleCode = createBundleCode({
    bundlePath: resolveBundlePath(ctx, target),
    transform: createBrowserTransform({
      patches,
      resolve: resolvePackageIdentity,
    }),
    patchIds: [...new Set(patches.map((patch) => patch.id))],
    fallback: options.fallback ?? 'error',
    target,
  })
  const route: ExactRoute = {
    kind: 'exact',
    path: options.route,
    handler: createBundleHandler(bundleCode),
  }
  const registration: { remove?: () => void } = {}
  ctx.effect(() => {
    registration.remove = httpServer.register(route)
    return (): void => {
      registration.remove?.()
    }
  }, `stent:serveBrowserTransform(${options.route})`)
  return (): void => {
    registration.remove?.()
  }
}

export type { ServeBrowserTransformOptions }
export { serveBrowserTransform }
