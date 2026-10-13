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
    overrideBrowserslist: ['safari >= 15'],
  },
  tools: {
    rspack: { watchOptions: { ignored: ['**/src-tauri/**', '**/node_modules/**'] } },
  },
  plugins: [litCss()],
});

/**
 * `*.css?inline` imports become Lit `CSSResult`s for `static styles`. Rsbuild's own `?inline` handling
 * compiles the CSS (nesting down-levelled for the targets) to a string default export; this wraps that
 * module's export in `unsafeCSS()`.
 * @returns {import('@rsbuild/core').RsbuildPlugin}
 */
function litCss() {
  return {
    name: 'brama:lit-css',
    setup(api) {
      api.modifyBundlerChain((chain) => {
        chain.module
          .rule('css')
          .oneOf('css-inline')
          .use('lit-css')
          .before('css')
          .loader(new URL('./scripts/lit-css-loader.cjs', import.meta.url).pathname);
      });
    },
  };
}
