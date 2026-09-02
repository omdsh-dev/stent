import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Installed-mode launcher resolution: without --dsh-path, stent-dsh runs a
 * registry-installed @deepseek-ai/dsh — the published lib/bin.js and bundled
 * preload are plain ESM, so the installed path needs neither tsx nor a
 * checkout. The CLI resolves from the caller's project dependencies or a PATH
 * shim (symlink shims and pnpm's cmd-shim script form alike). These offline
 * fixtures stand in for each resolution path; the stub `stent` in the profile
 * records what the preload delivered, and the stub `@deepseek-ai/dsh-app-boot`
 * records the pre-boot module-fallback heals.
 */
const repoRoot = path.join(import.meta.dirname, '..', '..')
const launcher = path.join(repoRoot, 'lib', 'stent-dsh.js')
const compiledPreload = path.join(repoRoot, 'lib', 'stent-dsh-preload.js')
if (!existsSync(launcher) || !existsSync(compiledPreload)) {
  throw new Error(
    'compiled launcher artifacts are missing; run pnpm run build before the launcher test',
  )
}
const sourceBundlePackageJson = path.join(repoRoot, 'package.json')
const commanderPackage = path.join(repoRoot, 'node_modules', 'commander')

const tempDir = mkdtempSync(path.join(tmpdir(), 'stent-installed-'))
const home = path.join(tempDir, 'home')
const profileDir = path.join(home, 'profiles', 't1')
const webProfileDir = path.join(home, 'profiles', 'web')
const webModules = path.join(webProfileDir, 'node_modules')
const proj = path.join(tempDir, 'proj')
const dshPkg = path.join(proj, 'node_modules', '@deepseek-ai', 'dsh')
const binFile = path.join(dshPkg, 'lib', 'bin.js')
const bootDir = path.join(proj, 'node_modules', '@deepseek-ai/dsh-app-boot')
const yamlDir = path.join(proj, 'node_modules', 'js-yaml')
const shimDir = path.join(tempDir, 'shims')
const scriptShimDir = path.join(tempDir, 'script-shims')
const stubStent = path.join(profileDir, 'node_modules', '@oh-my-dsh', 'stent')
const installedBundle = path.join(webModules, '@oh-my-dsh/stent-pack')
const installedBundlePackageJson = path.join(installedBundle, 'package.json')
const installedLib = path.join(installedBundle, 'lib')
const installedBin = path.join(webModules, '.bin', 'stent-dsh')

const SYSTEM_PATH = '/usr/bin:/bin'
const PROFILE_DUMP_ARGV = ['--profile', 't1', '--dump-config']
const WEB_FORWARDED_ARGV = '["--profile","web","--port","8000"]'
const PROFILE_FORWARDED_ARGV = '["--profile","t1","--dump-config"]'
const EXIT_SUCCESS = 0
const EXIT_FAILURE = 1
const NO_EXIT_STATUS = -1

const DSH_MANIFEST =
  '{"name":"@deepseek-ai/dsh","version":"9.9.9","type":"module","bin":{"dsh":"lib/bin.js"}}\n'
const FAKE_DSH_BIN = `console.log(\`FAKE-DSH argv=\${JSON.stringify(process.argv.slice(2))}\`)
console.log(\`FAKE-DSH config=\${process.env.STENT_CONFIG !== undefined} profile=\${process.env.STENT_PROFILE}\`)
console.log(\`FAKE-DSH node-options=\${process.env.NODE_OPTIONS}\`)
`
const BOOT_MANIFEST =
  '{"name":"@deepseek-ai/dsh-app-boot","version":"1.0.0","type":"module","main":"index.js"}\n'
const HEAL_STUB =
  "export function healProfilesModuleFallback(anchor) { console.log('HEAL-MARK ' + anchor) }\n"
const YAML_MANIFEST = '{"name":"js-yaml","version":"4.0.0","main":"index.js"}\n'
const FAKE_JS_YAML = `class Type { constructor() {} }
const DEFAULT_SCHEMA = { extend: () => ({}) }
const load = () => []
const dump = () => '[]\\n'
module.exports = { Type, DEFAULT_SCHEMA, load, dump }
`
const STENT_MANIFEST =
  '{"name":"@oh-my-dsh/stent","version":"1.0.0","type":"module","exports":{".":"./index.js","./activation":"./activation.js","./node":"./node.js"}}\n'
const PROFILE_STENT_INDEX =
  "export function markStentDshLaunch() { globalThis[Symbol.for('oh-my-dsh.stent-dsh.launch')] = true }\n"
const PROFILE_STENT_NODE =
  'export function installStentHooks() { console.log(`PROFILE-BOOT dynamic=true`) }\n'
const PROFILE_STENT_ACTIVATION =
  "export { markStentDshLaunch } from './index.js'\n"
const BUNDLE_MANIFEST =
  '{"name":"@oh-my-dsh/stent-pack","dependencies":{"@oh-my-dsh/stent":"file:packages/stent"}}\n'
const CMD_SHIM = `#!/bin/sh
basedir=$(dirname "$0")
exec node "$basedir/../nowhere" "$@"
# cmd-shim-target=${binFile}
`

const FIXTURE_FILES: readonly (readonly [string, string])[] = [
  /* The registry-installed CLI, then the CLI's own dependencies: the launcher
     falls back to them for js-yaml (not in the profile) and resolves
     dsh-app-boot from the CLI's real location for the pre-boot heal. */
  [path.join(dshPkg, 'package.json'), DSH_MANIFEST],
  [binFile, FAKE_DSH_BIN],
  [path.join(bootDir, 'package.json'), BOOT_MANIFEST],
  [path.join(bootDir, 'index.js'), HEAL_STUB],
  [path.join(yamlDir, 'package.json'), YAML_MANIFEST],
  [path.join(yamlDir, 'index.js'), FAKE_JS_YAML],
  /* The profile's installed trio copy is used by the installed bundle below.
     The source checkout launcher uses the Cordis-free Node API from its own
     dependency graph. */
  [path.join(profileDir, 'package.json'), '{}\n'],
  [path.join(stubStent, 'package.json'), STENT_MANIFEST],
  [path.join(stubStent, 'index.js'), PROFILE_STENT_INDEX],
  [path.join(stubStent, 'node.js'), PROFILE_STENT_NODE],
  [path.join(stubStent, 'activation.js'), PROFILE_STENT_ACTIVATION],
  /* An installed bundle bin derives `web` from this exact profile path. Keep
     this profile real (not a symlink), so the launcher exercises that path
     inference rather than only the generic installed mode. */
  [path.join(webProfileDir, 'package.json'), '{}\n'],
  [installedBundlePackageJson, BUNDLE_MANIFEST],
  /* A pnpm-style cmd-shim script on PATH; the symlink shim is linked below. */
  [path.join(scriptShimDir, 'dsh'), CMD_SHIM],
]

/** Own the on-disk files and links used by the launcher scenarios. */
class LauncherFixtureTree {
  private readonly root: string

  public constructor(root: string) {
    this.root = root
  }

  /** Write a fixture file, creating the directories it needs. */
  public writeFixture(file: string, content: string): void {
    const destination = this.ensureParent(file)
    writeFileSync(destination, content)
  }

  /** Copy a built artifact into the fixture tree. */
  public copyFixture(from: string, to: string): void {
    const destination = this.ensureParent(to)
    copyFileSync(from, destination)
  }

  /** Link a fixture path, creating the directories the link needs. */
  public linkFixture(target: string, link: string): void {
    const destination = this.ensureParent(link)
    symlinkSync(target, destination)
  }

  /** Drop the fixture tree so the next suite rebuilds it from scratch. */
  public removeFixtures(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  private ensureParent(file: string): string {
    const target = this.resolve(file)
    mkdirSync(path.dirname(target), { recursive: true })
    return target
  }

  private resolve(file: string): string {
    if (path.isAbsolute(file)) {
      return file
    }
    return path.join(this.root, file)
  }
}

const fixtureTree = new LauncherFixtureTree(tempDir)

/** Build the offline fixture tree every resolution path runs against. */
function installFixtures(): void {
  for (const [file, content] of FIXTURE_FILES) {
    fixtureTree.writeFixture(file, content)
  }
  mkdirSync(path.join(webModules, '@oh-my-dsh'), { recursive: true })
  symlinkSync(commanderPackage, path.join(webModules, 'commander'), 'dir')
  symlinkSync(stubStent, path.join(webModules, '@oh-my-dsh', 'stent'))
  fixtureTree.copyFixture(launcher, path.join(installedLib, 'stent-dsh.js'))
  fixtureTree.copyFixture(
    compiledPreload,
    path.join(installedLib, 'stent-dsh-preload.js'),
  )
  fixtureTree.linkFixture(
    '../@oh-my-dsh/stent-pack/lib/stent-dsh.js',
    installedBin,
  )
  fixtureTree.linkFixture(binFile, path.join(shimDir, 'dsh'))
}

interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}
interface RunOptions {
  readonly cwd?: string
  readonly path?: string
  readonly launcher?: string
}

/** Run the launcher with a profile-shaped environment. */
function run(argv: readonly string[], options: RunOptions = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
  delete env.STENT_CONFIG
  delete env.STENT_PROFILE
  if (options.path !== undefined) {
    env.PATH = options.path
  }
  const result = spawnSync(
    process.execPath,
    [options.launcher ?? launcher, ...argv],
    { cwd: options.cwd ?? home, encoding: 'utf8', env },
  )
  return {
    status: result.status ?? NO_EXIT_STATUS,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** The pre-boot heal ran against the CLI package and the bundle manifest. */
function expectHealedBoot(out: RunResult, bundleManifest: string): void {
  expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(EXIT_SUCCESS)
  expect(out.stdout).toContain(`HEAL-MARK ${path.join(dshPkg, 'package.json')}`)
  expect(out.stdout).toContain(`HEAL-MARK ${bundleManifest}`)
  expect(out.stdout).toContain('FAKE-DSH config=false')
  expect(out.stdout).toContain('FAKE-DSH node-options=')
}
/** The CLI received the profile's argv untouched, through the preload. */
function expectPreloadHandoff(
  out: RunResult,
  argv: string,
  profile: string,
): void {
  expect(out.stdout).toContain(`FAKE-DSH argv=${argv}`)
  expect(out.stdout).toContain('stent-dsh-preload.js')
  expect(out.stdout).toContain(`profile=${profile}`)
  expect(out.stderr).toContain('stent-dsh: exec ')
  expect(out.stderr).toContain(
    'stent: dynamic hooks installed — plugin patch registrations are live',
  )
}
/** A source-checkout boot: the launcher stays on its own dependency graph. */
function expectBoot(out: RunResult): void {
  expectHealedBoot(out, sourceBundlePackageJson)
  expectPreloadHandoff(out, PROFILE_FORWARDED_ARGV, profileDir)
  // 源码 launcher 使用自身依赖图中的静态 import，不会读取 profile 替代包。
  expect(out.stdout).not.toContain('PROFILE-BOOT count=0')
}
/** An installed-bundle boot: the profile's own Stent replacement boots. */
function expectInstalledWeb(out: RunResult): void {
  expectHealedBoot(out, installedBundlePackageJson)
  expectPreloadHandoff(out, WEB_FORWARDED_ARGV, webProfileDir)
  expect(out.stdout).toContain('PROFILE-BOOT dynamic=true')
}

describe('stent-dsh installed mode (registry-installed dsh)', () => {
  beforeAll(installFixtures)

  afterAll(fixtureTree.removeFixtures.bind(fixtureTree))

  it('uses --dsh-path as the DSH path selector', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    const source = path.join(tempDir, 'missing-source')
    const out = run(['--dsh-path', source, ...PROFILE_DUMP_ARGV], {
      path: SYSTEM_PATH,
    })
    expect(out.status).toBe(EXIT_FAILURE)
    expect(out.stderr).toContain(`DSH path does not exist: ${source}`)
  })

  it(
    'infers web and forwards it when invoked from the installed profile bin',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      expectInstalledWeb(
        run(['--port', '8000'], {
          launcher: installedBin,
          cwd: home,
          path: `${shimDir}:${SYSTEM_PATH}`,
        }),
      )
    },
  )

  it('resolves an explicit dsh path', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    expectBoot(run(['--dsh-path', binFile, ...PROFILE_DUMP_ARGV]))
  })
})

describe('stent-dsh installed mode CLI discovery', () => {
  beforeAll(installFixtures)

  afterAll(fixtureTree.removeFixtures.bind(fixtureTree))

  it(
    "resolves the CLI from the caller's project dependencies",
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      expectBoot(run(PROFILE_DUMP_ARGV, { cwd: proj, path: SYSTEM_PATH }))
    },
  )

  it('follows a symlink dsh shim on PATH', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    expectBoot(run(PROFILE_DUMP_ARGV, { path: `${shimDir}:${SYSTEM_PATH}` }))
  })

  it('follows a cmd-shim script dsh on PATH', { timeout: 30_000 }, () => {
    expect.hasAssertions()
    expectBoot(
      run(PROFILE_DUMP_ARGV, { path: `${scriptShimDir}:${SYSTEM_PATH}` }),
    )
  })

  it(
    'fails with guidance when no CLI is resolvable',
    { timeout: 30_000 },
    () => {
      expect.hasAssertions()
      const out = run(PROFILE_DUMP_ARGV, { path: SYSTEM_PATH })
      expect(out.status).toBe(EXIT_FAILURE)
      expect(out.stderr).toContain('no DSH path was supplied')
    },
  )
})
