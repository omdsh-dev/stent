import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

import { composeStentConfig } from '#src/stent-dsh/profile'

const DSH_ENABLED = [
  { id: 'dynamic-plugin', disabled: false },
  { id: 'stent-dsh', disabled: false },
]
const EMPTY_BUNDLE_LIST = 0

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
  bundles: readonly string[] = [],
): void {
  mkdirSync(profileDir, { recursive: true })
  const manifest: Record<string, unknown> = {}
  if (bundles.length !== EMPTY_BUNDLE_LIST) {
    manifest.dsh = { profile: { bundles: [...bundles] } }
  }
  writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(manifest)}\n`,
  )
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

/** Write a bundle manifest and patch layer next to the install anchor. */
function writeBundleFixture(root: string): void {
  const bundleDir = path.join(
    root,
    'node_modules',
    '@example',
    'profile-bundle',
  )
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    path.join(bundleDir, 'package.json'),
    JSON.stringify({
      name: '@example/profile-bundle',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  writeFileSync(
    path.join(bundleDir, 'cordis.patch.yml'),
    JSON.stringify([
      {
        insert: [
          {
            id: 'bundle-plugin',
            name: '@example/bundle-plugin',
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
    const installAnchor = path.join(root, 'package.json')
    writeFileSync(installAnchor, '{}\n')
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
      installAnchor: pathToFileURL(installAnchor),
    })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** Compose a throwaway profile for `mode` and assert against its overlay. */
function withComposedProfile(
  mode: string | undefined,
  assertions: (overlay: unknown, enablePath: string) => void,
): void {
  const root = mkdtempSync(path.join(tmpdir(), 'stent-profile-'))
  const profileDir = path.join(root, 'home', 'profiles', 'web')
  writeProfileFixture(profileDir, false)
  const result = composeOrCleanup(root, profileDir, mode)
  try {
    assertions(result.enableOverlay, fileURLToPath(result.enablePath))
  } finally {
    result.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Compose a legacy-config profile, which the composer must reject. */
function composeLegacyProfile(): void {
  const root = mkdtempSync(path.join(tmpdir(), 'stent-profile-'))
  const profileDir = path.join(root, 'home', 'profiles', 'web')
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
      withComposedProfile('web', (overlay, enablePath) => {
        expect(overlay).toStrictEqual(DSH_ENABLED)
        expect(loadOverlayPatches('test', enablePath)).toStrictEqual(
          DSH_ENABLED,
        )
      })
    },
  )

  it(
    'loads declared bundle patch layers through app-boot',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      const root = mkdtempSync(path.join(tmpdir(), 'stent-profile-'))
      const profileDir = path.join(root, 'home', 'profiles', 'web')
      writeProfileFixture(profileDir, false, ['@example/profile-bundle'])
      writeBundleFixture(root)
      const result = composeOrCleanup(root, profileDir, 'web')
      try {
        expect(result.enableOverlay).toStrictEqual([
          { id: 'bundle-plugin', disabled: false },
          ...DSH_ENABLED,
        ])
      } finally {
        result.cleanup()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it(
    'does not generate profile overlays for config dumps',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      withComposedProfile('--dump-config', (overlay, enablePath) => {
        expect(overlay).toStrictEqual([])
        expect(readFileSync(enablePath, 'utf8')).toBe('[]\n')
      })
    },
  )

  it(
    'does not generate profile overlays for plugin management',
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      withComposedProfile('plugin', (overlay, enablePath) => {
        expect(overlay).toStrictEqual([])
        expect(readFileSync(enablePath, 'utf8')).toBe('[]\n')
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
