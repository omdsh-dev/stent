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
 * preload 使用 Stent 的 Cordis-free loader 和 activation 子路径。它们可以静态解析,
 * 不会提前加载依赖 Cordis 的 StentService;只有存在 STENT_CONFIG 时才执行
 * launch marker 和 bootstrap。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { bootstrapStent } from '@oh-my-dsh/stent/node/loader'
import { markStentDshLaunch } from '@oh-my-dsh/stent/activation'
import type { StentPatchStub } from '@oh-my-dsh/stent/types'

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
