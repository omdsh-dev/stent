import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { runtime, validatePatchId, validatePatchStatic } from '#src/index'
import type { StentPatchInfo } from '#src/types'

/* Deeply readonly views of the mutable records these callbacks only read. */
type ChangeView = Readonly<{ type: string; id: string }>
type IdView = Readonly<{ id: string }>
type FileView = Readonly<{ file: string }>

/* Boolean outcomes are compared as single-element tuples: a bare `toBe(true)`
   and a bare `toBeTruthy()` each violate one of the two enabled matcher
   rules, while the tuple comparison stays exactly as strict. */

const NO_PATCHES = 0
const RECORDED_BINDINGS = 2
const OVERLONG_ID_LENGTH = 121
const NON_FUNCTION_HANDLER = 42
const baseTarget = { module: 'pkg', versionRange: '*' }
const fileTarget = { ...baseTarget, filePath: 'index.js' }
const sharedQuery = { file: 'index.js', fn: 'run' }
const requiredPatch = { target: fileTarget, operation: 'before' as const }
const indexJs = { module: 'pkg', file: 'index.js', nodes: 2 }
const libJs = { module: 'pkg', file: 'lib.js', nodes: 1 }
const runJs = { module: 'other', file: 'run.js', nodes: 1 }
const OVERLONG_ID = 'a'.repeat(OVERLONG_ID_LENGTH)
const UNSAFE_IDS = ['', 'has space', '汉字', OVERLONG_ID, 'semi;colon']

const INVALID_FILE_SELECTORS = [
  { files: { filePath: 'a.js', filePaths: ['b.js'] }, message: /not both/u },
  { files: { filePaths: [] }, message: /filePaths/u },
  { files: { filePaths: [''] }, message: /filePaths/u },
  { files: {}, message: /filePath or filePaths/u },
]

const noopHandler = function noopHandler(): void {
  /* Registry tests never dispatch through an installed handler. */
  return undefined
}

const baseInfo = (id: string): StentPatchInfo => ({
  id,
  target: { ...fileTarget },
  operation: 'before',
  priority: 0,
  enabled: false,
})

const queryInfo = (
  id: string,
  operation: 'before' | 'replace',
  query: Readonly<{ file: string; fn: string }> = sharedQuery,
): StentPatchInfo => ({
  ...baseInfo(id),
  target: {
    ...baseTarget,
    filePath: query.file,
    functionQuery: { functionName: query.fn, kind: 'Sync' },
  },
  operation,
})

const resetRegistry = (): void => {
  for (const info of runtime.list()) {
    runtime.remove(info.id)
  }
}

describe('stent runtime registry lifecycle', () => {
  beforeEach(resetRegistry)

  it('registers a patch as disabled', { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect([runtime.register(baseInfo('a'))]).toStrictEqual([true])
    expect([runtime.isEnabled('a')]).toStrictEqual([false])
  })

  it('enables, disables, and removes a patch', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('a'))
    runtime.enable('a', noopHandler)
    expect([runtime.isEnabled('a')]).toStrictEqual([true])
    runtime.disable('a')
    expect([runtime.isEnabled('a')]).toStrictEqual([false])
    runtime.remove('a')
    expect([runtime.isEnabled('a')]).toStrictEqual([false])
    expect(runtime.list()).toHaveLength(NO_PATCHES)
  })

  it('re-registration reports not-first', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('a'))
    expect([runtime.register(baseInfo('a'))]).toStrictEqual([false])
  })
})

describe('stent runtime handler installation', () => {
  beforeEach(resetRegistry)

  it('throws when enabling an unknown id', { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(() => {
      runtime.enable('nope', noopHandler)
    }).toThrow(/unregistered/u)
  })

  it('rejects a non-function handler', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('a'))
    expect(() => {
      // @ts-expect-error -- Enable must reject a handler that is not callable.
      runtime.enable('a', NON_FUNCTION_HANDLER)
    }).toThrow(/must be a function/u)
    expect([runtime.isEnabled('a')]).toStrictEqual([false])
  })
})

describe('stent runtime ownership', () => {
  beforeEach(resetRegistry)

  it('rejects an id owned by another owner', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('own/a'), 'owner-a')
    expect(() => {
      runtime.register(baseInfo('own/a'), 'owner-b')
    }).toThrow(/already registered by another owner/u)
    const reclaimed = runtime.register(baseInfo('own/a'), 'owner-a')
    expect([reclaimed]).toStrictEqual([false])
  })

  it('tracks the registering fiber', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('own/b'), 'owner', 'fiber-1')
    expect([runtime.isOwnedBy('own/b', 'fiber-1')]).toStrictEqual([true])
    expect([runtime.isOwnedBy('own/b', 'fiber-2')]).toStrictEqual([false])
  })

  it('transfers fiber ownership on re-register', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('own/b'), 'owner', 'fiber-1')
    const moved = runtime.register(baseInfo('own/b'), 'owner', 'fiber-2')
    expect([moved]).toStrictEqual([false])
    expect([runtime.isOwnedBy('own/b', 'fiber-1')]).toStrictEqual([false])
    expect([runtime.isOwnedBy('own/b', 'fiber-2')]).toStrictEqual([true])
    runtime.remove('own/b')
    expect([runtime.isOwnedBy('own/b', 'fiber-2')]).toStrictEqual([false])
  })
})

describe('stent runtime change notifications', () => {
  beforeEach(resetRegistry)

  it('notifies loader subscribers on change', { timeout: 5000 }, () => {
    expect.hasAssertions()
    const changes: string[] = []
    const unsubscribe = runtime.onPatchChange((change: ChangeView) => {
      changes.push(`${change.type}:${change.id}`)
    })
    runtime.register(baseInfo('watch/a'))
    runtime.register({ ...baseInfo('watch/a'), operation: 'after' })
    runtime.remove('watch/a')
    unsubscribe()
    expect(changes).toStrictEqual([
      'register:watch/a',
      'register:watch/a',
      'remove:watch/a',
    ])
  })

  it('orders list() and reflects enabled state', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register({ ...baseInfo('b'), priority: 2 })
    runtime.register({ ...baseInfo('a'), priority: 1 })
    runtime.register({ ...baseInfo('c'), priority: 1 })
    runtime.enable('c', noopHandler)
    const ids = runtime.list().map((info: IdView) => info.id)
    expect(ids).toStrictEqual(['a', 'c', 'b'])
    const listed = runtime.list().find((info: IdView) => info.id === 'c')
    expect([listed?.enabled]).toStrictEqual([true])
  })
})

describe('stent patch id validation', () => {
  it('rejects unsafe ids and accepts safe ones', { timeout: 5000 }, () => {
    expect.hasAssertions()
    for (const bad of UNSAFE_IDS) {
      expect(() => {
        validatePatchId(bad)
      }).toThrow(/patch id/u)
    }
    expect(() => {
      validatePatchId('vendor/pkg:patch-name_1.2')
    }).not.toThrow()
  })
})

describe('stent static patch validation', () => {
  it('rejects a non-boolean required flag', { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(() => {
      // @ts-expect-error -- required must be a boolean when it is present.
      validatePatchStatic({ ...requiredPatch, required: 'yes' })
    }).toThrow(/required must be a boolean/u)
    expect(() => {
      validatePatchStatic({ ...requiredPatch, required: true })
    }).not.toThrow()
  })

  it('accepts filePath or filePaths', { timeout: 5000 }, () => {
    expect.hasAssertions()
    const manyFiles = { ...baseTarget, filePaths: ['a.js', 'b.js'] }
    expect(() => {
      validatePatchStatic({ target: manyFiles, operation: 'before' })
    }).not.toThrow()
    const oneFile = { ...baseTarget, filePath: 'a.js' }
    expect(() => {
      validatePatchStatic({ target: oneFile, operation: 'before' })
    }).not.toThrow()
  })

  it('rejects invalid file selectors', { timeout: 5000 }, () => {
    expect.hasAssertions()
    for (const { files, message } of INVALID_FILE_SELECTORS) {
      expect(() => {
        validatePatchStatic({
          target: { ...baseTarget, ...files },
          operation: 'before',
        })
      }).toThrow(message)
    }
  })
})

describe('stent runtime replace conflicts', () => {
  beforeEach(resetRegistry)

  it('rejects a second replace on one target', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(queryInfo('r1', 'replace'))
    expect(() => {
      runtime.register(queryInfo('r2', 'replace'))
    }).toThrow(/conflicts with existing replace patch "r1"/u)
    const reclaimed = runtime.register(queryInfo('r1', 'replace'))
    expect([reclaimed]).toStrictEqual([false])
    runtime.register(queryInfo('b1', 'before'))
  })

  it('rejects a claimed replace target', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(queryInfo('x1', 'before'))
    runtime.register(queryInfo('z1', 'replace'))
    expect(() => {
      runtime.register(queryInfo('x1', 'replace'))
    }).toThrow(/conflicts with existing replace patch "z1"/u)
  })

  it('allows replace on different targets', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(queryInfo('x1', 'replace', { file: 'a.js', fn: 'f' }))
    runtime.register(queryInfo('x2', 'replace', { file: 'b.js', fn: 'g' }))
    const ids = runtime.list().map((info: IdView) => info.id)
    expect(ids).toStrictEqual(['x1', 'x2'])
  })
})

describe('stent runtime bindings', () => {
  beforeAll(() => {
    runtime.recordBindings('bind/a', [indexJs])
    runtime.recordBindings('bind/a', [libJs])
    runtime.recordBindings('bind/b', [runJs])
  })

  beforeEach(resetRegistry)

  it('records load-time bindings per patch', { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(runtime.bindingsOf('bind/a')).toStrictEqual([indexJs, libJs])
    expect(runtime.bindingsOf('bind/nope')).toStrictEqual([])
    const files = runtime.allBindings().map((record: FileView) => record.file)
    expect(files).toStrictEqual(['index.js', 'lib.js', 'run.js'])
  })

  it('merges bindings into list()', { timeout: 5000 }, () => {
    expect.hasAssertions()
    runtime.register(baseInfo('bind/a'))
    const listed = runtime.list().find((info: IdView) => info.id === 'bind/a')
    expect(listed?.bindings).toHaveLength(RECORDED_BINDINGS)
  })
})
