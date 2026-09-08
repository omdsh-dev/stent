import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseOpt } from '#src/stent-dsh/args'
import { resolveProfile } from '#src/stent-dsh/profile'

const EXIT_SUCCESS = 0
const root = path.join(import.meta.dirname, '..', '..')
const loader = path.join(root, 'lib', 'stent-loader.js')
const BIN_SOURCE =
  'console.log(JSON.stringify({ argv: process.argv.slice(2), profile: process.env.STENT_PROFILE, cwd: process.cwd() }))'

describe('loader-owned DSH host preparation', () => {
  it(
    'passes through a real pnpm process before reaching the host',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const directory = mkdtempSync(path.join(tmpdir(), 'stent-pnpm-'))
      const probe = path.join(root, 'tests', 'fixtures', 'non-dsh-host.mjs')
      writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({
          name: 'loader-test-host',
          scripts: { dsh: `node ${JSON.stringify(probe)}` },
        }),
      )
      try {
        const result = spawnSync(
          process.execPath,
          [
            path.join(root, 'lib', 'stent-dsh.js'),
            '--dsh',
            directory,
            '--profile',
            'unchanged',
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              NODE_OPTIONS: '',
              npm_config_verify_deps_before_run: 'false',
            },
          },
        )
        expect(result.status).toBe(EXIT_SUCCESS)
        expect(result.stdout).toContain('"activation":true')
        expect(result.stdout).toContain('"argv":["--profile","unchanged"]')
        expect(result.stdout).toContain(JSON.stringify(directory))
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it(
    'prepares the actual DSH entry without a launcher',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const directory = mkdtempSync(path.join(tmpdir(), 'stent-host-'))
      const home = path.join(directory, 'home')
      const profile = path.join(home, 'profiles', 't1')
      const cli = path.join(directory, 'cli')
      mkdirSync(path.join(cli, 'lib'), { recursive: true })
      mkdirSync(profile, { recursive: true })
      writeFileSync(
        path.join(cli, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }),
      )
      writeFileSync(path.join(profile, 'package.json'), '{}')
      const bin = path.join(cli, 'lib', 'bin.js')
      writeFileSync(bin, BIN_SOURCE)
      try {
        const result = spawnSync(
          process.execPath,
          ['--import', loader, bin, '--profile', 't1', '--dump-config'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: { ...process.env, NODE_OPTIONS: '', DSH_HOME: home },
          },
        )
        expect(result.stderr).toBe('')
        expect(result.status).toBe(EXIT_SUCCESS)
        expect(JSON.parse(result.stdout)).toStrictEqual({
          argv: ['--profile', 't1', '--dump-config'],
          profile,
          cwd: directory,
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it(
    'derives an installed profile from the loader URL',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const home = path.join(tmpdir(), 'stent-installed-home')
      const profile = path.join(home, 'profiles', 'web')
      const loaderUrl = pathToFileURL(
        path.join(
          profile,
          'node_modules',
          '@oh-my-dsh',
          'stent-pack',
          'lib',
          'stent-loader.js',
        ),
      )
      const opt = parseOpt(
        ['--port', '8000'],
        {},
        loaderUrl,
        pathToFileURL(root + path.sep),
      )
      const result = resolveProfile(opt)
      expect(result.profileDir).toStrictEqual(pathToFileURL(profile))
      expect(result.dshHome).toStrictEqual(pathToFileURL(home))
      expect(result.effectiveProfile).toBe('web')
    },
  )
})
