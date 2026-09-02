/**
 * Catalog entry shapes shared by the entry data and the registration adapter.
 *
 * @module @oh-my-dsh/stent-dsh/catalog-types
 */

/** One catalog parameter descriptor: name and description. */
interface CatalogParameter {
  readonly name: string
  readonly description: string
}

/** One catalog method descriptor registered against a service entry. */
interface CatalogMethod {
  readonly signature: string
  readonly description: string
  readonly parameters: readonly CatalogParameter[]
  readonly returns?: string
}

/** One catalog service entry (a keyed API surface). */
interface CatalogService {
  readonly key: string
  readonly summary: string
  readonly description: string
  readonly methods: readonly CatalogMethod[]
}

/** One catalog type declaration entry (a named code snippet). */
interface CatalogDeclaration {
  readonly name: string
  readonly declaration: string
}

/** A stent catalog entry: a service surface or a type declaration. */
type CatalogEntry = CatalogService | CatalogDeclaration

export type {
  CatalogDeclaration,
  CatalogEntry,
  CatalogMethod,
  CatalogParameter,
  CatalogService,
}
