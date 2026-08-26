/**
 * Compatibility entry for the browser build transform API.
 *
 * The implementation is kept with the transform implementation in
 * `transform/browser.ts`; this path preserves the established public import.
 * @module @oh-my-dsh/stent/browser/transform
 */

export {
  createBrowserTransform,
  createWatchedBrowserTransform,
  nodeModulesResolver,
  nodePackageResolver,
  repoSourceResolver,
} from '../transform/browser.ts'
export type {
  IdentityResolver,
  InstrumentationConfig,
  ModuleIdentity,
  TransformOutput,
  WatchedBrowserTransform,
} from '../transform/browser.ts'
