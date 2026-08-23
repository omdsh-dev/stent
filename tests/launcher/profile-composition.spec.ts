import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeStentConfig } from '../../src/stent-dsh/profile.ts'

const patch = {
  id: 'launcher/test-patch',
  target: {
    module: '@example/target',
    versionRange: '^1.0.0',
    filePath: 'lib/index.js',
    functionQuery: { functionName: 'greet', kind: 'Sync' },
  },
  operation: 'before',
}

class FakeYamlType {
  constructor(
    readonly tag: string,
    readonly options: unknown,
  ) {}
}

function createYaml(): {
  Type: new (tag: string, options: unknown) => unknown
  DEFAULT_SCHEMA: { extend: (types: unknown[]) => unknown }
  load: (text: string) => unknown
  dump: (value: unknown) => string
} {
  return {
    Type: FakeYamlType,
    DEFAULT_SCHEMA: { extend: (_types: unknown[]) => ({}) },
    load: text => JSON.parse(text) as unknown,
    dump: value => JSON.stringify(value),
  }
}

function compose(mode: string | undefined): {
  root: string
  result: ReturnType<typeof composeStentConfig>
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'stent-profile-'))
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{}\n')
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    JSON.stringify([
      {
        insert: [
          {
            id: 'stent',
            name: '@oh-my-dsh/stent',
            disabled: true,
            config: { stent: { patches: [patch] } },
          },
          { id: 'stent-dsh', name: '@oh-my-dsh/stent-dsh', disabled: true },
        ],
      },
    ]),
  )

  const result = composeStentConfig({
    args: {
      dshPath: undefined,
      profile: 'web',
      dshHome: undefined,
      pathEnv: undefined,
      env: {},
      launcherUrl: new URL(import.meta.url),
      cwd: pathToFileURL(root),
      patchFiles: [],
      passthrough: mode === undefined ? [] : [mode],
    },
    dshHome: pathToFileURL(join(root, 'home')),
    profileDir: pathToFileURL(profileDir),
    requireFromProfile: createRequire(pathToFileURL(join(profileDir, 'package.json'))),
    yaml: createYaml(),
  })

  return {
    root,
    result,
    cleanup: () => {
      result.cleanup()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('stent profile composition', () => {
  it('enables the DSH integration during a Stent profile boot', () => {
    const composed = compose('web')
    try {
      expect(composed.result.patches).toHaveLength(1)
      expect(composed.result.enableOverlay).toEqual([{ id: 'stent-dsh', disabled: false }])
      expect(JSON.parse(readFileSync(composed.result.enablePath, 'utf8'))).toEqual([
        { id: 'stent-dsh', disabled: false },
      ])
    } finally {
      composed.cleanup()
    }
  })

  it('does not generate profile overlays for config dumps', () => {
    const composed = compose('--dump-config')
    try {
      expect(composed.result.enableOverlay).toEqual([])
      expect(readFileSync(composed.result.enablePath, 'utf8')).toBe('[]\n')
    } finally {
      composed.cleanup()
    }
  })

  it('does not generate profile overlays for plugin management', () => {
    const composed = compose('plugin')
    try {
      expect(composed.result.enableOverlay).toEqual([])
      expect(readFileSync(composed.result.enablePath, 'utf8')).toBe('[]\n')
    } finally {
      composed.cleanup()
    }
  })
})
