/**
 * stent-dsh preload: installs the Stent transformation hooks before the
 * CLI entry module loads. The composed descriptors are passed through
 * STENT_CONFIG (a JSON file written by the Stent launcher), so this
 * file stays host-source-agnostic.
 *
 * Source launches run `node --import tsx/esm --import <this file> apps/cli/src/bin.ts`;
 * installed launches use the compiled JavaScript artifact emitted beside the
 * launcher. The source uses only erasable TypeScript syntax so tsx can load it
 * directly. bootstrapStent registers the loader hooks exactly where the
 * patched profile-boot used to call installStentBootstrap (boot prepare,
 * before any target import) — except no host source change is involved. It
 * also records the process-local stent-dsh launch capability before Host
 * plugins can resolve their Stent dependency.
 *
 * The trio resolves from the profile when STENT_PROFILE is set: the
 * profile's installed copy is authoritative at runtime — the Host plugin and
 * every consumer plugin import that same copy, so hooks, binding reports,
 * and handlers share one module instance. (A static import cannot express
 * this: when this file ships inside the installed bundle, Node's package
 * self-reference would bind it to an inner copy instead of the profile's.)
 * Without the env the preload resolves from its own location (dev/sandbox
 * layout, tsx source mapping).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StentPatchStub } from '@oh-my-dsh/stent'

type BootstrapStent = (descriptors: StentPatchStub[]) => unknown
type MarkStentDshLaunch = () => void

const configPath = process.env.STENT_CONFIG
if (configPath !== undefined && configPath !== '') {
  let bootstrapStent: BootstrapStent
  let markStentDshLaunch: MarkStentDshLaunch
  const profileDir = process.env.STENT_PROFILE
  if (profileDir !== undefined && profileDir !== '') {
    const resolveFrom = createRequire(pathToFileURL(join(profileDir, 'package.json')))
    ;({ bootstrapStent, markStentDshLaunch } = await import(pathToFileURL(resolveFrom.resolve('@oh-my-dsh/stent')).href))
  } else {
    ;({ bootstrapStent, markStentDshLaunch } = await import('@oh-my-dsh/stent'))
  }
  markStentDshLaunch()
  const descriptors = JSON.parse(readFileSync(configPath, 'utf8')) as StentPatchStub[]
  bootstrapStent(descriptors)
  // The launch marker: only a Stent launcher reaches this line, so the
  // boot output always tells the user whether this is a Stent-enabled launch
  // or a plain host one.
  process.stderr.write(`stent: Stent hooks installed (${descriptors.length} descriptor(s)) — this launch is stent-enabled\n`)
}
