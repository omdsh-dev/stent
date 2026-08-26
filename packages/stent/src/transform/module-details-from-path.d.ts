/**
 * Ambient declaration for `module-details-from-path` — a tiny CJS helper that
 * maps a module filename back to its owning npm package name, package
 * directory, and package-relative path. The upstream package ships no types,
 * so this project-owned declaration is the transform identity contract.
 * @module module-details-from-path
 */

declare module 'module-details-from-path' {
  /** One resolved module location, when the filename lies inside a package. */
  interface ModuleDetails {
    /** The owning npm package name. */
    name: string
    /** Absolute directory of the owning package (file URL form for ESM URLs). */
    basedir: string
    /** Path of the file relative to the package root. */
    path: string
  }

  /**
   * Resolve a filename (or file URL) to its owning package.
   * @param filename - absolute path or file URL string.
   * @returns the package details, or `undefined` outside any package.
   */
  function parse(filename: string): ModuleDetails | undefined

  export default parse
}
