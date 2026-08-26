import { defineConfig } from 'tsdown'

/**
 * stent-api is a pure host package with one aggregate entry and the
 * compat facade's direct subpaths.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'compat/service': 'src/compat/service.ts',
    'compat/types': 'src/compat/types.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
