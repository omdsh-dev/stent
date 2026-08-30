import { beforeEach, describe, expect, it } from 'vitest'

import {
  runtime,
  validatePatchId,
  validatePatchStatic,
} from '../../src/index.ts'

const baseInfo = (id: string, enabled = false) => ({
  id,
  target: { module: 'pkg', versionRange: '*', filePath: 'index.js' },
  operation: 'before' as const,
  priority: 0,
  enabled,
})

beforeEach(() => {
  for (const info of runtime.list()) {
    runtime.remove(info.id)
  }
})

describe('stent runtime registry lifecycle', () => {
  it('registers, enables, disables, and removes patches', () => {
    expect(runtime.register(baseInfo('a'))).toBe(true)
    expect(runtime.isEnabled('a')).toBe(false)
    const handler = () => {
      return undefined
    }
    runtime.enable('a', handler)
    expect(runtime.isEnabled('a')).toBe(true)
    runtime.disable('a')
    expect(runtime.isEnabled('a')).toBe(false)
    runtime.remove('a')
    expect(runtime.isEnabled('a')).toBe(false)
    expect(runtime.list()).toHaveLength(0)
  })

  it('notifies loader subscribers when static metadata changes', () => {
    const changes: string[] = []
    const unsubscribe = runtime.onPatchChange((change) =>
      changes.push(`${change.type}:${change.id}`),
    )
    runtime.register(baseInfo('watch/a'))
    runtime.register({ ...baseInfo('watch/a'), operation: 'after' })
    runtime.remove('watch/a')
    unsubscribe()
    expect(changes).toEqual([
      'register:watch/a',
      'register:watch/a',
      'remove:watch/a',
    ])
  })

  it('re-registering an id keeps metadata but reports not-first', () => {
    runtime.register(baseInfo('a'))
    expect(runtime.register(baseInfo('a'))).toBe(false)
  })

  it('rejects an id registered by a different owner', () => {
    runtime.register({ ...baseInfo('own/a') }, 'owner-a')
    expect(() => {
      runtime.register({ ...baseInfo('own/a') }, 'owner-b')
    }).toThrow(/already registered by another owner/)
    expect(runtime.register({ ...baseInfo('own/a') }, 'owner-a')).toBe(false)
  })

  it('same-owner re-registration transfers fiber ownership', () => {
    runtime.register({ ...baseInfo('own/b') }, 'owner', 'fiber-1')
    expect(runtime.isOwnedBy('own/b', 'fiber-1')).toBe(true)
    expect(runtime.isOwnedBy('own/b', 'fiber-2')).toBe(false)
    expect(runtime.register({ ...baseInfo('own/b') }, 'owner', 'fiber-2')).toBe(
      false,
    )
    expect(runtime.isOwnedBy('own/b', 'fiber-1')).toBe(false)
    expect(runtime.isOwnedBy('own/b', 'fiber-2')).toBe(true)
    runtime.remove('own/b')
    expect(runtime.isOwnedBy('own/b', 'fiber-2')).toBe(false)
  })

  it('list() orders by priority then id and reflects enabled state', () => {
    runtime.register({ ...baseInfo('b', false), priority: 2 })
    runtime.register({ ...baseInfo('a', false), priority: 1 })
    runtime.register({ ...baseInfo('c', false), priority: 1 })
    runtime.enable('c', () => {})
    const ids = runtime.list().map((info) => info.id)
    expect(ids).toEqual(['a', 'c', 'b'])
    expect(runtime.list().find((info) => info.id === 'c')?.enabled).toBe(true)
  })

  it('enable on an unregistered id throws', () => {
    expect(() => {
      runtime.enable('nope', () => {})
    }).toThrow(/unregistered/)
  })

  it('enable with a non-function handler fails loud instead of crashing in dispatch', () => {
    runtime.register(baseInfo('a'))
    expect(() => {
      runtime.enable('a', 42 as never)
    }).toThrow(/must be a function/)
    expect(runtime.isEnabled('a')).toBe(false)
  })
})

describe('stent runtime validation', () => {
  it('validatePatchId rejects unsafe ids and accepts safe ones', () => {
    for (const bad of [
      '',
      'has space',
      '汉字',
      'a'.repeat(121),
      'semi;colon',
    ]) {
      expect(() => {
        validatePatchId(bad)
      }).toThrow(/patch id/)
    }
    expect(() => {
      validatePatchId('vendor/pkg:patch-name_1.2')
    }).not.toThrow()
  })

  it('validatePatchStatic rejects a non-boolean required flag', () => {
    const target = { module: 'pkg', versionRange: '*', filePath: 'index.js' }
    expect(() => {
      validatePatchStatic({
        target,
        operation: 'before',
        required: 'yes' as never,
      })
    }).toThrow(/required must be a boolean/)
    expect(() => {
      validatePatchStatic({ target, operation: 'before', required: true })
    }).not.toThrow()
  })

  it('validatePatchStatic accepts filePaths and rejects invalid combinations', () => {
    const base = { module: 'pkg', versionRange: '*' }
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePaths: ['a.js', 'b.js'] },
        operation: 'before',
      })
    }).not.toThrow()
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePath: 'a.js' },
        operation: 'before',
      })
    }).not.toThrow()
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePath: 'a.js', filePaths: ['b.js'] },
        operation: 'before',
      })
    }).toThrow(/not both/)
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePaths: [] },
        operation: 'before',
      })
    }).toThrow(/filePaths/)
    expect(() => {
      validatePatchStatic({
        target: { ...base, filePaths: [''] },
        operation: 'before',
      })
    }).toThrow(/filePaths/)
    expect(() => {
      validatePatchStatic({ target: { ...base }, operation: 'before' })
    }).toThrow(/filePath or filePaths/)
  })
})

describe('stent runtime replace conflicts', () => {
  it('rejects a second replace patch on the same target', () => {
    const target = {
      module: 'pkg',
      versionRange: '*',
      filePath: 'index.js',
      functionQuery: { functionName: 'run', kind: 'Sync' as const },
    }
    runtime.register({
      id: 'r1',
      target,
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
    expect(() => {
      runtime.register({
        id: 'r2',
        target,
        operation: 'replace',
        priority: 0,
        enabled: false,
      })
    }).toThrow(/conflicts with existing replace patch "r1"/)
    expect(
      runtime.register({
        id: 'r1',
        target,
        operation: 'replace',
        priority: 0,
        enabled: false,
      }),
    ).toBe(false)
    runtime.register({
      id: 'b1',
      target,
      operation: 'before',
      priority: 0,
      enabled: false,
    })
  })

  it('re-registering into an already-claimed replace target still fails', () => {
    const target = {
      module: 'pkg',
      versionRange: '*',
      filePath: 'index.js',
      functionQuery: { functionName: 'run', kind: 'Sync' as const },
    }
    runtime.register({
      id: 'x1',
      target,
      operation: 'before',
      priority: 0,
      enabled: false,
    })
    runtime.register({
      id: 'z1',
      target,
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
    expect(() => {
      runtime.register({
        id: 'x1',
        target,
        operation: 'replace',
        priority: 0,
        enabled: false,
      })
    }).toThrow(/conflicts with existing replace patch "z1"/)
  })

  it('allows replace patches on different targets', () => {
    runtime.register({
      id: 'x1',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'a.js',
        functionQuery: { functionName: 'f', kind: 'Sync' as const },
      },
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
    runtime.register({
      id: 'x2',
      target: {
        module: 'pkg',
        versionRange: '*',
        filePath: 'b.js',
        functionQuery: { functionName: 'g', kind: 'Sync' as const },
      },
      operation: 'replace',
      priority: 0,
      enabled: false,
    })
  })
})

describe('stent runtime bindings', () => {
  it('records load-time bindings per patch and merges them into list()', () => {
    runtime.recordBindings('bind/a', [
      { module: 'pkg', file: 'index.js', nodes: 2 },
    ])
    runtime.recordBindings('bind/a', [
      { module: 'pkg', file: 'lib.js', nodes: 1 },
    ])
    runtime.recordBindings('bind/b', [
      { module: 'other', file: 'run.js', nodes: 1 },
    ])
    expect(runtime.bindingsOf('bind/a')).toEqual([
      { module: 'pkg', file: 'index.js', nodes: 2 },
      { module: 'pkg', file: 'lib.js', nodes: 1 },
    ])
    expect(runtime.bindingsOf('bind/nope')).toEqual([])
    expect(runtime.allBindings().map((record) => record.file)).toEqual([
      'index.js',
      'lib.js',
      'run.js',
    ])
    runtime.register({
      id: 'bind/a',
      target: { module: 'pkg', versionRange: '*', filePath: 'index.js' },
      operation: 'before',
      priority: 0,
      enabled: false,
    })
    expect(
      runtime.list().find((info) => info.id === 'bind/a')?.bindings,
    ).toHaveLength(2)
  })
})
