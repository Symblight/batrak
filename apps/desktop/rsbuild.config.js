import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rsbuild/core';

// The bundle and the favicon tag (`public/favicon.svg`) are injected into index.html.
export default defineConfig({
  source: { entry: { index: './src/main.js' } },
  html: { template: './index.html' },
  server: { port: 1420, strictPort: true },
  // Lazy compilation (on by default) rebuilds when a dynamic import is first requested — every
  // CodeMirror language — and without HMR that rebuild reloads the page.
  dev: { hmr: false, liveReload: true, lazyCompilation: false },
  output: {
    distPath: { root: 'dist' },
    overrideBrowserslist: ['safari >= 18.2'],
  },
  tools: {
    rspack: { watchOptions: { ignored: ['**/src-tauri/**', '**/node_modules/**'] } },
  },
  plugins: [litCss(), linkedPackages({ '@symblight/chat': process.env.BATRAK_CHAT_DIR })],
});

/**
 * Points each package whose local checkout is given (`BATRAK_CHAT_DIR=../rich-components/packages/chat
 * pnpm dev`) at that checkout's `dist`, for testing it before it's pushed. The installed copy stays in
 * node_modules. Imports from inside a checkout look in the app's node_modules first, so it shares the
 * app's `lit` and `wc-material` instead of loading its own (two wc-materials define every `md-*` tag
 * twice); Rsbuild's `resolve.dedupe` can't, it skips packages that don't export `package.json`.
 * @param {Record<string, string | undefined>} dirs package name → checkout folder
 * @returns {import('@rsbuild/core').RsbuildPlugin}
 */
function linkedPackages(dirs) {
  /** @type {Record<string, string>} */
  const alias = {};
  /** @type {string[]} */
  const roots = [];
  for (const [name, dir] of Object.entries(dirs)) {
    if (!dir) continue;
    const root = path.resolve(dir);
    const { exports } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const [subpath, target] of Object.entries(exports)) {
      const file = typeof target === 'string' ? target : target.import;
      alias[`${path.posix.join(name, subpath)}$`] = path.join(root, file);
    }
    roots.push(root);
    console.info(`[batrak] ${name} → ${root}`);
  }
  return {
    name: 'batrak:linked-packages',
    setup(api) {
      if (!roots.length) return;
      api.modifyBundlerChain((chain) => {
        for (const [name, file] of Object.entries(alias)) chain.resolve.alias.set(name, file);
        chain.module
          .rule('linked-packages')
          .include.merge(roots)
          .end()
          .resolve.modules.merge([path.resolve('node_modules'), 'node_modules']);
      });
    },
  };
}

/**
 * `*.css?inline` imports become Lit `CSSResult`s for `static styles`. Rsbuild's own `?inline` handling
 * compiles the CSS (nesting down-levelled for the targets) to a string default export; this wraps that
 * module's export in `unsafeCSS()`.
 * @returns {import('@rsbuild/core').RsbuildPlugin}
 */
function litCss() {
  return {
    name: 'batrak:lit-css',
    setup(api) {
      api.modifyBundlerChain((chain) => {
        chain.module
          .rule('css')
          .oneOf('css-inline')
          .use('lit-css')
          .before('css')
          .loader(fileURLToPath(new URL('./scripts/lit-css-loader.cjs', import.meta.url)));
      });
    },
  };
}
