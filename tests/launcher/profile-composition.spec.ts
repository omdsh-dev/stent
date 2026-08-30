import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { composeStentConfig } from '../../src/stent-dsh/profile.ts'

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
    load: (text) => JSON.parse(text) as unknown,
    dump: (value) => JSON.stringify(value),
  }
}

function compose(
  mode: string | undefined,
  legacyPatchConfig = false,
): {
  root: string
  result: ReturnType<typeof composeStentConfig>
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'stent-profile-'))
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{}\n')
  let stentConfig: Record<string, unknown>
  if (legacyPatchConfig) {
    stentConfig = { stent: { patches: [{ id: 'legacy/patch' }] } }
  } else {
    stentConfig = { stent: { dynamic: true } }
  }

  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    JSON.stringify([
      {
        insert: [
          {
            id: 'stent',
            name: '@oh-my-dsh/stent',
            disabled: true,
            config: stentConfig,
          },
          { id: 'stent-dsh', name: '@oh-my-dsh/stent-dsh', disabled: true },
          {
            id: 'dynamic-plugin',
            name: '@example/dynamic-plugin',
            disabled: true,
            config: { stent: true },
          },
        ],
      },
    ]),
  )

  const passthrough: string[] = []
  if (mode !== undefined) {
    passthrough.push(mode)
  }

  let result: ReturnType<typeof composeStentConfig>
  try {
    result = composeStentConfig({
      args: {
        dshPath: undefined,
        profile: 'web',
        dshHome: undefined,
        pathEnv: undefined,
        launcherUrl: new URL(import.meta.url),
        cwd: pathToFileURL(root),
        patchFiles: [],
        passthrough,
      },
      dshHome: pathToFileURL(join(root, 'home')),
      profileDir: pathToFileURL(profileDir),
      requireFromProfile: createRequire(
        pathToFileURL(join(profileDir, 'package.json')),
      ),
      yaml: createYaml(),
    })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }

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
      expect(composed.result.enableOverlay).toEqual([
        { id: 'dynamic-plugin', disabled: false },
        { id: 'stent-dsh', disabled: false },
      ])
      expect(
        JSON.parse(readFileSync(composed.result.enablePath, 'utf8')),
      ).toEqual([
        { id: 'dynamic-plugin', disabled: false },
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

  it('rejects legacy YAML patch descriptors instead of silently ignoring them', () => {
    expect(() => compose('web', true)).toThrow(
      /config\.stent\.patches.*register patch metadata in plugin code/,
    )
  })
})
