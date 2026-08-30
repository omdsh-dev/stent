/**
 * Validation for the static descriptors consumed by the transform layer.
 *
 * The runtime and platform adapters may reuse these guards, but the
 * transformation layer never imports those modules.
 *
 * @module @oh-my-dsh/stent/transform/validation
 */

import type { PatchId, StentPatchStub } from './types.ts'

/** Validate a patch id for diagnostics and generated bridge calls. */
export function validatePatchId(id: PatchId): void {
  if (!/^[A-Za-z0-9._:/+-]{1,120}$/.test(id)) {
    throw new Error(
      `stent: patch id ${JSON.stringify(id)} must be 1-120 chars of [A-Za-z0-9._:/+-]`,
    )
  }
}

type PatchTarget = StentPatchStub['target']

function validateTargetModule(target: PatchTarget): void {
  if (typeof target.module !== 'string' || target.module.length === 0) {
    throw new Error('stent: patch target.module must be a non-empty string')
  }
}

function validateVersionRange(target: PatchTarget): void {
  if (
    typeof target.versionRange !== 'string'
    || target.versionRange.length === 0
  ) {
    throw new Error(
      'stent: patch target.versionRange must be a non-empty string',
    )
  }
}

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
    || target.filePaths.length === 0
    || target.filePaths.some(
      (path) => typeof path !== 'string' || path.length === 0,
    )
  ) {
    throw new Error(
      'stent: patch target.filePaths must be a non-empty array of non-empty strings',
    )
  }
}

function validateRequired(required: unknown): void {
  if (required !== undefined && typeof required !== 'boolean') {
    throw new Error('stent: patch.required must be a boolean when present')
  }
}

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

function validateOperation(operation: StentPatchStub['operation']): void {
  if (!['before', 'after', 'around', 'replace'].includes(operation)) {
    throw new Error(`stent: unknown operation ${JSON.stringify(operation)}`)
  }
}

/** Validate static patch fields before an instrumentation is built. */
export function validatePatchStatic(
  patch: Pick<StentPatchStub, 'target' | 'operation' | 'required'>,
): void {
  validateTargetModule(patch.target)
  validateVersionRange(patch.target)
  validateFilePaths(patch.target)
  validateRequired(patch.required)
  validateTargetIndices(patch.target)
  validateOperation(patch.operation)
}

/** Whether an index is unset, null, or a non-negative integer. */
function isValidIndex(index: number | null | undefined): boolean {
  if (index === undefined || index === null) {
    return true
  }
  if (!Number.isInteger(index)) {
    return false
  }
  return index >= 0
}
