/**
 * Compatibility entry for package identity helpers.
 *
 * The implementation lives in `transform/identity.ts` with the matcher
 * adapters; this Node path remains for existing subpath consumers.
 * @module @oh-my-dsh/stent/node/identity
 */

export {
  detectModuleType,
  getPackageVersion,
  nodePackageIdentity,
  packageIdentityFromPath,
} from '../transform/identity.ts'
export type { PackageIdentity } from '../transform/identity.ts'
