import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const EXIT_SUCCESS = 0
const root = path.join(import.meta.dirname, '..', '..')
const preload = path.join(root, 'src', 'stent-loader.ts')
const entry = path.join(root, 'tests', 'fixtures', 'preload-entry.mjs')

describe('stent loader import contract', () => {
  it('does not activate without the loader import', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const result = spawnSync(process.execPath, [entry], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(EXIT_SUCCESS)
    expect(result.stdout).toContain('active=false result=5')
  })

  it(
    'activates directly without launcher handshake variables',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const env = { ...process.env }
      delete env.STENT_DSH_LAUNCH
      delete env.STENT_DSH_PATH
      delete env.STENT_LAUNCHER_CWD
      delete env.STENT_PRELOAD_DONE
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx/esm', '--import', preload, entry],
        {
          cwd: root,
          encoding: 'utf8',
          env,
        },
      )
      expect(result.stderr).toBe('')
      expect(result.status).toBe(EXIT_SUCCESS)
      expect(result.stdout).toContain('active=true result=23')
    },
  )
})
