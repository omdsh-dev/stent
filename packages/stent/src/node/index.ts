/**
 * Node-facing Stent API: install the runtime transformation hooks and inspect
 * or refresh already-loaded targets. Patch metadata and handlers are supplied
 * by the platform-free `StentService`; this entry owns only Node lifecycle
 * operations.
 *
 * @module @oh-my-dsh/stent/node
 */

export {
  checkRequiredPatches,
  flushBindingReports,
  installStentHooks,
  retransformCommonJs,
  retransformEsm,
} from './loader/loader.ts'
