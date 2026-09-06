import { describe, expect, it } from 'vitest'

import { publish, subscribeBridge } from '#src/bridge'

const NO_CALLS = 0
const ONE_CALL = 1

const call = {
  id: 'bridge/test',
  operation: 'before' as const,
  arguments: [],
  self: undefined,
  traced: (): string => 'original',
}

describe('bridge dispatcher lifecycle', () => {
  it(
    'dispatches in subscription order and disposes idempotently',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const seen: string[] = []
      let firstCalls = NO_CALLS
      let secondCalls = NO_CALLS
      const disposeFirst = subscribeBridge((nextCall) => {
        firstCalls += ONE_CALL
        seen.push(nextCall.id)
        return 'first'
      })
      const disposeSecond = subscribeBridge(() => {
        secondCalls += ONE_CALL
        return 'second'
      })

      const result = publish(call)
      disposeFirst()
      disposeFirst()
      disposeSecond()
      disposeSecond()
      const fallback = publish(call)

      expect({ result, fallback, seen, firstCalls, secondCalls }).toStrictEqual(
        {
          result: 'second',
          fallback: 'original',
          seen: ['bridge/test'],
          firstCalls: ONE_CALL,
          secondCalls: ONE_CALL,
        },
      )
    },
  )
})
