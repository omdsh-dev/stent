import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { composeStentConfig } from '#src/stent-dsh/profile'

const DSH_ENABLED = [
  { id: 'dynamic-plugin', disabled: false },
  { id: 'stent-dsh', disabled: false },
]

/** The Stent plugin config a profile carries, in its current or legacy shape. */
function stentPluginConfig(
  legacyPatchConfig: boolean,
): Record<string, unknown> {
  if (legacyPatchConfig) {
    return { stent: { patches: [{ id: 'legacy/patch' }] } }
  }
  return { stent: { dynamic: true } }
}

/** Write the profile manifest and the patch layer the composer reads. */
function writeProfileFixture(
  profileDir: string,
  legacyPatchConfig: boolean,
): void {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), '{}\n')
  writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    JSON.stringify([
      {
        insert: [
          {
            id: 'stent',
            name: '@oh-my-dsh/stent',
            disabled: true,
            config: stentPluginConfig(legacyPatchConfig),
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
}

/** The passthrough argv the launcher would hand to the composer. */
function passthroughArgs(mode: string | undefined): string[] {
  if (mode === undefined) {
    return []
  }
  return [mode]
}

/** Compose against the fixture, removing the fixture when composition fails. */
function composeOrCleanup(
  root: string,
  profileDir: string,
  mode: string | undefined,
): ReturnType<typeof composeStentConfig> {
  try {
    return composeStentConfig({
      args: {
        dshPath: undefined,
        profile: 'web',
        dshHome: undefined,
        pathEnv: undefined,
        launcherUrl: new URL(import.meta.url),
        cwd: pathToFileURL(root),
        patchFiles: [],
        passthrough: passthroughArgs(mode),
      },
      dshHome: pathToFileURL(path.join(root, 'home')),
      profileDir: pathToFileURL(profileDir),
    })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** Compose a throwaway profile for `mode` and assert against its overlay. */
function withComposedProfile(
  mode: string | undefined,
  assertions: (overlay: unknown, enableText: string) => void,
): void {
  const root = mkdtempSync(path.join(tmpdir(), 'stent-profile-'))
  const profileDir = path.join(root, 'profile')
  writeProfileFixture(profileDir, false)
  const result = composeOrCleanup(root, profileDir, mode)
  try {
    assertions(result.enableOverlay, readFileSync(result.enablePath, 'utf8'))
  } finally {
    result.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Compose a legacy-config profile, which the composer must reject. */
function composeLegacyProfile(): void {
  const root = mkdtempSync(path.join(tmpdir(), 'stent-profile-'))
  const profileDir = path.join(root, 'profile')
  writeProfileFixture(profileDir, true)
  const result = composeOrCleanup(root, profileDir, 'web')
  result.cleanup()
  rmSync(root, { recursive: true, force: true })
}

describe('stent profile composition', () => {
  it(
    'enables the DSH integration during a Stent profile boot',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      withComposedProfile('web', (overlay, enableText) => {
        expect(overlay).toStrictEqual(DSH_ENABLED)
        expect(loadYaml(enableText)).toStrictEqual(DSH_ENABLED)
      })
    },
  )

  it(
    'does not generate profile overlays for config dumps',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      withComposedProfile('--dump-config', (overlay, enableText) => {
        expect(overlay).toStrictEqual([])
        expect(enableText).toBe('[]\n')
      })
    },
  )

  it(
    'does not generate profile overlays for plugin management',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      withComposedProfile('plugin', (overlay, enableText) => {
        expect(overlay).toStrictEqual([])
        expect(enableText).toBe('[]\n')
      })
    },
  )

  it(
    'rejects legacy YAML patch descriptors instead of silently ignoring them',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(composeLegacyProfile).toThrow(
        /config\.stent\.patches.*register patch metadata in plugin code/u,
      )
    },
  )
})
