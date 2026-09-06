import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseOpt } from '#src/stent-dsh/args'

describe('stent launcher argument parsing', () => {
  it(
    'accepts repeated --patch options from an empty Commander state',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const cwd = pathToFileURL(
        path.join(path.sep, 'tmp', 'stent-cwd') + path.sep,
      )
      const args = parseOpt(
        ['--patch', 'first.yml', '--patch', 'second.yml', 'web', '--app-flag'],
        { PATH: '' },
        new URL('file:///launcher'),
        cwd,
        new URL('file:///dsh'),
      )

      expect(args.patchFiles.map((file) => fileURLToPath(file))).toStrictEqual([
        path.join(path.sep, 'tmp', 'stent-cwd', 'first.yml'),
        path.join(path.sep, 'tmp', 'stent-cwd', 'second.yml'),
      ])
      expect(args.passthrough).toStrictEqual(['web', '--app-flag'])
    },
  )
})
