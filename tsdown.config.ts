import { defineConfig } from 'tsdown'

/**
 * The published bundle exposes a Node bin and its native Node preload.
 * Build them as separate entries so each published file is self-contained;
 * the npm carrier publishes only these two files and their source maps.
 */
const nodeOutput = {
  outDir: 'lib',
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'node22',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
}

export default [
  defineConfig({
    ...nodeOutput,
    entry: {
      'stent-dsh': 'src/stent-dsh.ts',
    },
    clean: true,
  }),
  defineConfig({
    ...nodeOutput,
    entry: {
      'stent-dsh-preload': 'src/stent-dsh-preload.ts',
    },
    clean: false,
  }),
]
