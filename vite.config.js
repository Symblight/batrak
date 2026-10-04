import { defineConfig } from 'vite';
import postcssLit from 'rollup-plugin-postcss-lit';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'safari15',
    outDir: 'dist',
  },
  // `*.css?inline` imports become Lit `CSSResult`s for `static styles`
  plugins: [postcssLit()],
});
