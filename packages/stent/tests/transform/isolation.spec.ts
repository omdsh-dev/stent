import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const transformDirectory = fileURLToPath(new URL('../../src/transform/', import.meta.url))

describe('transform module boundary', () => {
  it('does not import package-local modules outside transform', () => {
    const violations: string[] = []
    for (const file of readdirSync(transformDirectory).filter(name => name.endsWith('.ts'))) {
      const source = readFileSync(`${transformDirectory}/${file}`, 'utf8')
      for (const match of source.matchAll(/\b(?:from|import)\s*['"](\.\.\/[^'"]+)['"]/g)) {
        violations.push(`${file}: ${match[1]}`)
      }
    }
    expect(violations).toEqual([])
  })
})
