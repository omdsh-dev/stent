import { describe, expect, it } from 'vitest'

import { createLoaderState } from '#src/loader/state'

const EMPTY_COUNT = 0
const ONE_COUNT = 1

describe('loader state lifecycle', () => {
  it(
    'makes disposal terminal for future state commits',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      let listCalls = 0
      const state = createLoaderState(false, () => {
        listCalls += ONE_COUNT
        return []
      })

      state.dispose()
      state.dispose()
      state.refresh(() => {
        listCalls += ONE_COUNT
        return []
      })
      state.recordMatch('stale')
      state.markSeen('stale')
      state.collectLoadedModule('stale')
      state.markRetransformQueued()
      state.retransformPass = Promise.resolve()

      const queued = state.takeQueuedWork()
      expect({
        active: state.active,
        listCalls,
        instrumentationCount: state.instrumentations.length,
        pending: state.pendingEntries(),
        seen: state.hasSeen('stale'),
        queued: state.isRetransformQueued(),
        pass: state.retransformPass,
        work: queued,
      }).toStrictEqual({
        active: false,
        listCalls: ONE_COUNT,
        instrumentationCount: EMPTY_COUNT,
        pending: [],
        seen: false,
        queued: false,
        pass: undefined,
        work: { previousMatchers: [], loadedModules: [] },
      })
    },
  )
})
