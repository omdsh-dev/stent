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
 * preload 使用普通的静态 import 引入 `@oh-my-dsh/stent`，包会从 launcher
 * 的依赖图中解析。在 installed 模式下，launcher 会在此模块加载前将 bundle
 * 的依赖闭包修复到 profile 中，因此 preload 和 Host plugin 仍然使用同一份包。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { bootstrapStent, markStentDshLaunch, type StentPatchStub } from '@oh-my-dsh/stent'

const configPath = process.env.STENT_CONFIG
if (configPath !== undefined && configPath !== '') {
  const configUrl = pathToFileURL(configPath)
  markStentDshLaunch()
  const descriptors = JSON.parse(readFileSync(configUrl, 'utf8')) as StentPatchStub[]
  bootstrapStent(descriptors)
  // The launch marker: only a Stent launcher reaches this line, so the
  // boot output always tells the user whether this is a Stent-enabled launch
  // or a plain host one.
  process.stderr.write(
    `stent: Stent hooks installed (${descriptors.length} descriptor(s)) — this launch is stent-enabled\n`,
  )
}
