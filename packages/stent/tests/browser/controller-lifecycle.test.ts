import { describe, expect, it } from 'vitest'

import { BundleCodeCache } from '#src/browser/bundle-cache'
import { ExactRouteController } from '#src/browser/route-controller'
import type {
  ExactRoute,
  WebServerService,
} from '#src/browser/route-controller'

const NO_CALLS = 0
const ONE_CALL = 1
const TWO_CALLS = 2
const NO_LENGTH = 0

const route: ExactRoute = {
  kind: 'exact',
  path: '/bundle.js',
  handler: () => {
    if (route.path.length < NO_LENGTH) {
      throw new Error('unreachable route')
    }
  },
}

describe('browser lifecycle owners', () => {
  it(
    'caches bundle code only while source content is unchanged',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      let source = 'first'
      let reads = NO_CALLS
      let transforms = NO_CALLS
      const cache = new BundleCodeCache(
        () => {
          reads += ONE_CALL
          return source
        },
        (value) => {
          transforms += ONE_CALL
          return value.toUpperCase()
        },
      )

      const first = cache.read()
      const cached = cache.read()
      source = 'second'
      const refreshed = cache.read()
      cache.clear()
      const cleared = cache.read()

      expect({
        first,
        cached,
        refreshed,
        cleared,
        reads,
        transforms,
      }).toStrictEqual({
        first: 'FIRST',
        cached: 'FIRST',
        refreshed: 'SECOND',
        cleared: 'SECOND',
        reads: ONE_CALL + TWO_CALLS + ONE_CALL,
        transforms: TWO_CALLS + ONE_CALL,
      })
    },
  )

  it(
    'owns exact route installation and idempotent disposal',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const registered: ExactRoute[] = []
      let removals = NO_CALLS
      let cleanups = NO_CALLS
      const server: WebServerService = {
        register(nextRoute) {
          registered.push(nextRoute)
          return () => {
            removals += ONE_CALL
          }
        },
      }
      const controller = new ExactRouteController(server, route, () => {
        cleanups += ONE_CALL
      })

      controller.install()
      controller.install()
      controller.dispose()
      controller.dispose()
      controller.install()
      controller.dispose()

      expect({
        registered: registered.length,
        removals,
        cleanups,
      }).toStrictEqual({
        registered: TWO_CALLS,
        removals: TWO_CALLS,
        cleanups: TWO_CALLS,
      })
    },
  )
})
