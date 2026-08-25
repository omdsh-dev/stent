import { defineConfig } from 'tsdown'

/**
 * stent is a dual-face package: the node half (index, the
 * loader-thread hook entry, and the testkit pair) plus the browser client
 * bundle. tsdown compiles the source entries directly; the hook entry is a
 * third node artifact the async loader fallback resolves.
 */
export default [
  defineConfig({
    entry: {
      'index': 'src/index.ts',
      'types': 'src/types.ts',
      'activation': 'src/activation.ts',
      'node/loader': 'src/node/loader.ts',
      'node/hook-entry': 'src/node/hook-entry.ts',
      'node/identity': 'src/node/identity.ts',
      'node/wire': 'src/node/wire.ts',
      'browser/transform': 'src/browser/transform.ts',
      'browser/serve': 'src/browser/serve.ts',
      'hmr/ownership': 'src/hmr/ownership.ts',
      'hmr/reload': 'src/hmr/reload.ts',
      'transform/config': 'src/transform/config.ts',
      'transform/transform': 'src/transform/transform.ts',
      'testing/testkit': 'src/testing/testkit.ts',
      'testing/testkit-runner': 'src/testing/testkit-runner.ts',
      'browser/client': 'src/browser/client/index.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
  }),
  defineConfig({
    entry: {
      'client': 'src/browser/client/index.ts',
    },
    outDir: 'lib',
    // Browser half ships in the host closure-factory artifact: the web shell
    // loads /plugins/<id>/client.js as a classic script and resolves value
    // imports through the loader module table (require), so the bundle
    // registers window.__ModuleLoader__.load({id, factory}) and keeps
    // @deepseek-ai/cordis external (a platform seed entry).
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: ['@deepseek-ai/cordis'],
      alwaysBundle: (id) => !id.startsWith('@deepseek-ai/cordis'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@oh-my-dsh/stent", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }),
]
