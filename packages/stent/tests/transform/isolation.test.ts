import { readFile, readdir } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

/** Directory holding the transform source files the boundary check scans. */
const transformDirectory = new URL('../../src/transform/', import.meta.url)

/** Parent-relative imports the transform must not contain. */
const PARENT_IMPORT_PATTERN =
  /\b(?:from|import)\s*['"](?<importPath>\.\.\/[^'"]+)['"]/gu

describe('transform module boundary', () => {
  it(
    'does not import package-local modules outside transform',
    { timeout: 60_000 },
    async () => {
      expect.hasAssertions()
      const entries = await readdir(transformDirectory)
      const files = entries.filter((name) => name.endsWith('.ts'))
      const scanResults = await Promise.all(
        files.map(async (file) => {
          const source = await readFile(
            new URL(file, transformDirectory),
            'utf8',
          )
          const imports: string[] = []
          for (const match of source.matchAll(PARENT_IMPORT_PATTERN)) {
            imports.push(`${file}: ${match.groups?.importPath}`)
          }
          return imports
        }),
      )
      const violations = scanResults.flat()
      expect(violations).toStrictEqual([])
    },
  )
})
