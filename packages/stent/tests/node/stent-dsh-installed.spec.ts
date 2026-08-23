import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Installed-mode launcher resolution: without --source, stent-dsh runs a
 * registry-installed @deepseek-ai/dsh — the published lib/bin.js and bundled
 * preload are plain ESM, so the installed path needs neither tsx nor a
 * checkout. The CLI resolves from DSH_CLI, the
 * caller's project dependencies, or a PATH shim (symlink shims and pnpm's
 * cmd-shim script form alike). These offline fixtures stand in for each
 * resolution path; the stub `stent` in the profile records what the
 * preload delivered, and the stub `@deepseek-ai/dsh-app-boot` records the
 * pre-boot module-fallback heals.
 */
const compiledLauncher = fileURLToPath(new URL('../../../../lib/stent-dsh.js', import.meta.url))
const compiledPreload = fileURLToPath(new URL('../../../../lib/stent-dsh-preload.js', import.meta.url))
if (!existsSync(compiledLauncher) || !existsSync(compiledPreload)) throw new Error('compiled launcher artifacts are missing; run pnpm run build before the launcher test')
const launcher = compiledLauncher
const sourceBundlePackageJson = fileURLToPath(new URL('../../../../package.json', import.meta.url))

const tempDir = mkdtempSync(join(tmpdir(), 'stent-installed-'))
const home = join(tempDir, 'home')
const profileDir = join(home, 'profiles', 't1')
const webProfileDir = join(home, 'profiles', 'web')
const proj = join(tempDir, 'proj')
const dshPkg = join(proj, 'node_modules', '@deepseek-ai', 'dsh')
const binFile = join(dshPkg, 'lib', 'bin.js')
const shimDir = join(tempDir, 'shims')
const scriptShimDir = join(tempDir, 'script-shims')

mkdirSync(join(dshPkg, 'lib'), { recursive: true })
writeFileSync(join(dshPkg, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh', version: '9.9.9', type: 'module', bin: { dsh: 'lib/bin.js' },
}, null, 2))
writeFileSync(binFile, [
  'console.log(`FAKE-DSH argv=${JSON.stringify(process.argv.slice(2))}`)',
  'console.log(`FAKE-DSH config=${process.env.STENT_CONFIG !== undefined} profile=${process.env.STENT_PROFILE}`)',
  '',
].join('\n'))

// The CLI's own dependencies: the launcher falls back to them for js-yaml
// (not in the profile) and resolves dsh-app-boot from the CLI's real
// location for the pre-boot heal.
mkdirSync(join(proj, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
writeFileSync(join(proj, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-app-boot', version: '1.0.0', type: 'module', main: 'index.js',
}))
writeFileSync(join(proj, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'index.js'),
  "export function healProfilesModuleFallback(anchor) { console.log('HEAL-MARK ' + anchor) }\n")
mkdirSync(join(proj, 'node_modules', 'js-yaml'), { recursive: true })
writeFileSync(join(proj, 'node_modules', 'js-yaml', 'package.json'), JSON.stringify({
  name: 'js-yaml', version: '4.0.0', main: 'index.js',
}))
writeFileSync(join(proj, 'node_modules', 'js-yaml', 'index.js'), [
  'class Type { constructor() {} }',
  'const DEFAULT_SCHEMA = { extend: () => ({}) }',
  'const load = () => []',
  "const dump = () => '[]\\n'",
  'module.exports = { Type, DEFAULT_SCHEMA, load, dump }',
  '',
].join('\n'))

// The profile's installed trio copy (the preload resolves it through
// STENT_PROFILE): a stub stent recording the descriptor count.
const stubStent = join(profileDir, 'node_modules', '@oh-my-dsh', 'stent')
mkdirSync(stubStent, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), '{}\n')
writeFileSync(join(stubStent, 'package.json'), JSON.stringify({
  name: '@oh-my-dsh/stent', version: '1.0.0', type: 'module', exports: { '.': './index.js' },
}))
writeFileSync(join(stubStent, 'index.js'),
  'export function markStentDshLaunch() { globalThis[Symbol.for(\'oh-my-dsh.stent-dsh.launch\')] = true }\n'
  + 'export function bootstrapStent(descriptors) { console.log(`PROFILE-BOOT count=${descriptors.length}`) }\n')

// An installed bundle bin derives `web` from this exact profile path. Keep
// this profile real (not a symlink), so the launcher exercises that path
// inference rather than only the generic installed mode.
mkdirSync(join(webProfileDir, 'node_modules', '@oh-my-dsh'), { recursive: true })
writeFileSync(join(webProfileDir, 'package.json'), '{}\n')
symlinkSync(stubStent, join(webProfileDir, 'node_modules', '@oh-my-dsh', 'stent'))
const installedBundle = join(webProfileDir, 'node_modules', '@oh-my-dsh/stent-pack')
const installedLauncherFile = 'stent-dsh.js'
const installedLauncher = join(installedBundle, 'lib', installedLauncherFile)
const installedBundlePackageJson = join(installedBundle, 'package.json')
mkdirSync(join(installedBundle, 'lib'), { recursive: true })
writeFileSync(installedBundlePackageJson, JSON.stringify({
  name: '@oh-my-dsh/stent-pack',
  dependencies: { '@oh-my-dsh/stent': 'file:packages/stent' },
}, null, 2))
copyFileSync(launcher, installedLauncher)
copyFileSync(compiledPreload, join(installedBundle, 'lib', 'stent-dsh-preload.js'))
mkdirSync(join(webProfileDir, 'node_modules', '.bin'), { recursive: true })
symlinkSync(`../@oh-my-dsh/stent-pack/lib/${installedLauncherFile}`, join(webProfileDir, 'node_modules', '.bin', 'stent-dsh'))

// PATH shims: a symlink (npm-global style) and a cmd-shim script (pnpm).
mkdirSync(shimDir, { recursive: true })
symlinkSync(binFile, join(shimDir, 'dsh'))
mkdirSync(scriptShimDir, { recursive: true })
writeFileSync(join(scriptShimDir, 'dsh'), [
  '#!/bin/sh',
  'basedir=$(dirname "$0")',
  'exec node "$basedir/../nowhere" "$@"',
  `# cmd-shim-target=${binFile}`,
  '',
].join('\n'))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function run(
  argv: string[],
  options: { cwd?: string; path?: string; launcher?: string; dsh?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
  delete env.DSH_SOURCE
  delete env.DSH_CLI
  delete env.STENT_CONFIG
  delete env.STENT_PROFILE
  if (options.dsh !== undefined) env.DSH_CLI = options.dsh
  if (options.path !== undefined) env.PATH = options.path
  const selectedLauncher = options.launcher ?? launcher
  const result = spawnSync(process.execPath, [selectedLauncher, ...argv], {
    cwd: options.cwd ?? home,
    encoding: 'utf8',
    env,
  })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

function expectBoot(out: { status: number; stdout: string; stderr: string }): void {
  expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0)
  // The pre-boot heal ran against the CLI package's own manifest...
  expect(out.stdout).toContain(`HEAL-MARK ${join(dshPkg, 'package.json')}`)
  // ...and the bundle's own dependency closure is added to the same fallback.
  expect(out.stdout).toContain(`HEAL-MARK ${sourceBundlePackageJson}`)
  // ...the CLI received the profile's argv untouched...
  expect(out.stdout).toContain('FAKE-DSH argv=["--profile","t1","--dump-config"]')
  expect(out.stdout).toContain('FAKE-DSH config=true')
  expect(out.stdout).toContain(`profile=${profileDir}`)
  // ...and the preload installed the hooks from the profile's trio copy.
  expect(out.stdout).toContain('PROFILE-BOOT count=0')
  expect(out.stderr).toContain('stent: Stent hooks installed (0 descriptor(s))')
}

function expectInstalledWeb(out: { status: number; stdout: string; stderr: string }): void {
  expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0)
  expect(out.stdout).toContain(`HEAL-MARK ${join(dshPkg, 'package.json')}`)
  expect(out.stdout).toContain(`HEAL-MARK ${installedBundlePackageJson}`)
  expect(out.stdout).toContain('FAKE-DSH argv=["--profile","web","--port","8000"]')
  expect(out.stdout).toContain('FAKE-DSH config=true')
  expect(out.stdout).toContain(`profile=${webProfileDir}`)
  expect(out.stdout).toContain('PROFILE-BOOT count=0')
  expect(out.stderr).toContain('stent: Stent hooks installed (0 descriptor(s))')
}

describe('stent-dsh installed mode (registry-installed dsh)', () => {
  it('uses --source as the source-checkout selector', () => {
    const source = join(tempDir, 'missing-source')
    const out = run(['--source', source, '--profile', 't1', '--dump-config'], { path: '/usr/bin:/bin' })
    expect(out.status).toBe(1)
    expect(out.stderr).toContain(`no CLI entry at ${join(source, 'apps/cli/src/bin.ts')}`)
  })

  it('infers web and forwards it when invoked from the installed profile bin', () => {
    expectInstalledWeb(run(['--port', '8000'], {
      launcher: join(webProfileDir, 'node_modules', '.bin', 'stent-dsh'),
      cwd: home,
      path: `${shimDir}:/usr/bin:/bin`,
    }))
  })

  it('resolves an explicit DSH_CLI override', () => {
    expectBoot(run(['--profile', 't1', '--dump-config'], { dsh: binFile }))
  })

  it("resolves the CLI from the caller's project dependencies", () => {
    expectBoot(run(['--profile', 't1', '--dump-config'], { cwd: proj, path: '/usr/bin:/bin' }))
  })

  it('follows a symlink dsh shim on PATH', () => {
    expectBoot(run(['--profile', 't1', '--dump-config'], { path: `${shimDir}:/usr/bin:/bin` }))
  })

  it('follows a cmd-shim script dsh on PATH', () => {
    expectBoot(run(['--profile', 't1', '--dump-config'], { path: `${scriptShimDir}:/usr/bin:/bin` }))
  })

  it('fails with guidance when no CLI is resolvable', () => {
    const out = run(['--profile', 't1', '--dump-config'], { path: '/usr/bin:/bin' })
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('no installed @deepseek-ai/dsh found')
    expect(out.stderr).toContain('DSH_CLI')
  })
})
