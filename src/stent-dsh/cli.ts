import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ENTRY_INDEX = 1

/** Identify the running DSH entry, never discover a different CLI. */
function resolveHost(): URL | undefined {
  const [entry] = process.argv.slice(ENTRY_INDEX)
  if (entry === undefined || !existsSync(entry)) {
    return undefined
  }
  const realEntry = realpathSync(entry)
  const manifestPath = findPackageJSON(pathToFileURL(realEntry))
  if (manifestPath === undefined) {
    return undefined
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    typeof manifest !== 'object'
    || manifest === null
    || !('name' in manifest)
    || manifest.name !== '@deepseek-ai/dsh'
  ) {
    return undefined
  }
  const root = path.dirname(manifestPath)
  const relativeEntry = path.relative(root, realEntry).split(path.sep).join('/')
  if (relativeEntry !== 'lib/bin.js' && relativeEntry !== 'src/bin.ts') {
    return undefined
  }
  return pathToFileURL(manifestPath)
}

export { resolveHost }
