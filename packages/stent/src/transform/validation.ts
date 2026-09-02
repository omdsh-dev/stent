/**
 * Validation for the static descriptors consumed by the transform layer.
 *
 * The runtime and platform adapters may reuse these guards, but the
 * transformation layer never imports those modules.
 *
 * @module @oh-my-dsh/stent/transform/validation
 */

import type { PatchId, StentPatchStub } from './types.ts'

/** Length of an empty string or an empty path list. */
const EMPTY_LENGTH = 0
/** The smallest valid zero-based match index. */
const MINIMUM_INDEX = 0

/**
 * Validate the patch id embedded in generated bridge calls and diagnostics.
 *
 * @remarks
 *   The TypeScript signature requires `PatchId`/`string`, but the
 *   regular-expression check itself coerces a JavaScript non-string value;
 *   later transform metadata still expects a string.
 * @param id - Patch identifier to validate.
 * @throws If `id` is empty, longer than 120 characters, or contains a character
 *   outside `[A-Za-z0-9._:/+-]`.
 */
function validatePatchId(id: PatchId): void {
  if (!/^[A-Za-z0-9._:/+-]{1,120}$/u.test(id)) {
    throw new Error(
      `stent: patch id ${JSON.stringify(id)} must be 1-120 chars of [A-Za-z0-9._:/+-]`,
    )
  }
}

type PatchTarget = StentPatchStub['target']

/** Validate the target module name. */
function validateTargetModule(target: PatchTarget): void {
  if (
    typeof target.module !== 'string'
    || target.module.length === EMPTY_LENGTH
  ) {
    throw new Error('stent: patch target.module must be a non-empty string')
  }
}

/** Validate the target version range as a non-empty string. */
function validateVersionRange(target: PatchTarget): void {
  if (
    typeof target.versionRange !== 'string'
    || target.versionRange.length === EMPTY_LENGTH
  ) {
    throw new Error(
      'stent: patch target.versionRange must be a non-empty string',
    )
  }
}

/**
 * Validate the mutually exclusive file selector fields without path
 * normalization.
 */
function validateFilePaths(target: PatchTarget): void {
  const hasFilePath =
    typeof target.filePath === 'string' || target.filePath instanceof RegExp
  if (!hasFilePath && target.filePaths === undefined) {
    throw new Error('stent: patch target must carry filePath or filePaths')
  }
  if (hasFilePath && target.filePaths !== undefined) {
    throw new Error(
      'stent: patch target must carry filePath or filePaths, not both',
    )
  }
  if (target.filePaths === undefined) {
    return
  }
  if (
    !Array.isArray(target.filePaths)
    || target.filePaths.length === EMPTY_LENGTH
    || target.filePaths.some(
      (path) => typeof path !== 'string' || path.length === EMPTY_LENGTH,
    )
  ) {
    throw new Error(
      'stent: patch target.filePaths must be a non-empty array of non-empty strings',
    )
  }
}

/** Validate the optional required flag. */
function validateRequired(required: unknown): void {
  if (required !== undefined && typeof required !== 'boolean') {
    throw new Error('stent: patch.required must be a boolean when present')
  }
}

/** Whether an index is unset, null, or a non-negative integer. */
function isValidIndex(index: number | null | undefined): boolean {
  if (index === undefined || index === null) {
    return true
  }
  if (!Number.isInteger(index)) {
    return false
  }
  return index >= MINIMUM_INDEX
}

/** Validate match indices on the target and function query. */
function validateTargetIndices(target: PatchTarget): void {
  if (!isValidIndex(target.index)) {
    throw new Error(
      'stent: patch target.index must be a non-negative integer or null',
    )
  }
  if (!isValidIndex(target.functionQuery?.index)) {
    throw new Error(
      'stent: patch target functionQuery.index must be a non-negative integer or null',
    )
  }
}

/** Validate the operation encoded into the bridge call. */
function validateOperation(operation: StentPatchStub['operation']): void {
  if (!['before', 'after', 'around', 'replace'].includes(operation)) {
    throw new Error(`stent: unknown operation ${JSON.stringify(operation)}`)
  }
}

/**
 * Validate static module, file, index, required, and operation fields.
 *
 * This is intentionally a partial guard: it does not validate the patch id,
 * query syntax or shape, semver grammar, priority, or an executable handler.
 * Those checks belong to the caller and to `expandPatchStub`.
 *
 * @param patch - Static fields to check.
 * @throws If one of the supported static fields has an invalid shape.
 */
function validatePatchStatic(
  patch: Pick<StentPatchStub, 'target' | 'operation' | 'required'>,
): void {
  validateTargetModule(patch.target)
  validateVersionRange(patch.target)
  validateFilePaths(patch.target)
  validateRequired(patch.required)
  validateTargetIndices(patch.target)
  validateOperation(patch.operation)
}

export { validatePatchId, validatePatchStatic }
