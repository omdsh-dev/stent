import { describe, expect, it } from 'vitest'

import { AsyncLoaderController } from '#src/loader/async'

const NO_CALLS = 0
const ONE_CALL = 1

describe('async loader controller lifecycle', () => {
  it(
    'deactivates once and permits a later installation',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const controller = new AsyncLoaderController()
      let flushes = NO_CALLS
      const removeWaiter = controller.addFlushWaiter(() => {
        flushes += ONE_CALL
      })

      controller.markInstalled()
      controller.deactivate()
      controller.deactivate()
      removeWaiter()
      controller.markInstalled()

      expect({
        installed: controller.installed,
        host: controller.host,
        flushes,
      }).toStrictEqual({
        installed: true,
        host: undefined,
        flushes: ONE_CALL,
      })
    },
  )
})
