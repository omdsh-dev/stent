/**
 * Browser/build-facing Stent API.
 *
 * Browser consumers work with public Stent patch stubs and an identity
 * resolver; conversion to the internal Orchestrion representation stays inside
 * the transform layer. Runtime bundle serving is exposed from this same
 * platform entry instead of the package root.
 *
 * @module @oh-my-dsh/stent/browser
 */

export { serveBrowserTransform } from './serve.ts'
export type { ServeBrowserTransformOptions } from './serve.ts'
export {
  createBrowserTransform,
  createWatchedBrowserTransform,
  repoSourceResolver,
} from '#src/transform/browser'
export { resolvePackageIdentity } from '#src/transform/identity'
export type {
  BrowserTransform,
  BrowserTransformOptions,
  IdentityResolver,
  ModuleIdentity,
  RepoSourceResolverOptions,
  TransformOutput,
  WatchedBrowserTransform,
  WatchedBrowserTransformOptions,
} from '#src/transform/browser'
