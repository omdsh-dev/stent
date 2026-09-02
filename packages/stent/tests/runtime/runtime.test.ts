import { afterEach, describe, expect, it } from 'vitest'

import { publish, subscribeBridge } from '#src/bridge'
import type { StentBridgeCall } from '#src/index'

/** Splice from the first index: drain every disposer recorded by a test. */
const FIRST_DISPOSER = 0

/** Single call argument the fixture publishes; handlers never read it. */
const CALL_ARGUMENT = 1

/** One transformed call, as the bridge receives it from patched code. */
const call = (id: string): StentBridgeCall => ({
  id,
  operation: 'before',
  arguments: [CALL_ARGUMENT],
  self: undefined,
  traced: (): string => 'traced',
})

describe('bridge multi-listener dispatch', () => {
  const disposers: (() => void)[] = []
  afterEach(() => {
    for (const dispose of disposers.splice(FIRST_DISPOSER)) {
      dispose()
    }
  })

  it(
    'runs every listener in registration order and returns the last result',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const seen: string[] = []
      disposers.push(
        subscribeBridge(() => {
          seen.push('first')
          return 'first-result'
        }),
        subscribeBridge(() => {
          seen.push('second')
          return 'second-result'
        }),
      )
      expect(publish(call('bridge/multi'))).toBe('second-result')
      expect(seen).toStrictEqual(['first', 'second'])
    },
  )

  it(
    'disposed listeners stop receiving calls; the traced fallback takes over',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const dispose = subscribeBridge(() => 'handled')
      dispose()
      expect(publish(call('bridge/none'))).toBe('traced')
    },
  )
})
