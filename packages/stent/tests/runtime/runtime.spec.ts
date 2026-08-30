import { afterEach, describe, expect, it } from 'vitest'

import { publish, subscribeBridge } from '../../src/bridge.ts'

describe('bridge multi-listener dispatch', () => {
  const disposers: Array<() => void> = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose()
    }
  })

  const call = (id: string) => ({
    id,
    operation: 'before' as const,
    arguments: [1],
    self: undefined,
    traced: () => 'traced',
  })

  it('runs every listener in registration order and returns the last result', () => {
    const seen: string[] = []
    disposers.push(
      subscribeBridge(() => {
        seen.push('first')
        return 'first-result'
      }),
    )
    disposers.push(
      subscribeBridge(() => {
        seen.push('second')
        return 'second-result'
      }),
    )
    expect(publish(call('bridge/multi'))).toBe('second-result')
    expect(seen).toEqual(['first', 'second'])
  })

  it('disposed listeners stop receiving calls; the traced fallback takes over', () => {
    const dispose = subscribeBridge(() => 'handled')
    dispose()
    expect(publish(call('bridge/none'))).toBe('traced')
  })
})
