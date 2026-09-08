import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const EXIT_SUCCESS = 0
const root = path.join(import.meta.dirname, '..', '..')
const launcher = path.join(root, 'lib', 'stent-dsh.js')
const probe = path.join(root, 'tests', 'fixtures', 'process-argv.mjs')

describe('thin stent-dsh launcher', () => {
  it(
    'selects an explicit command and injects the loader',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const result = spawnSync(
        process.execPath,
        [launcher, '--dsh', process.execPath, probe, 'ok'],
        {
          cwd: root,
          encoding: 'utf8',
          env: process.env,
        },
      )
      expect(result.stderr).toBe('')
      expect(result.status).toBe(EXIT_SUCCESS)
      expect(result.stdout).toContain('ok')
      expect(result.stdout).toContain('nodeOptions')
    },
  )
})
