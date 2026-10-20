import { readFile } from 'node:fs/promises';
import { chromeLauncher } from '@web/test-runner-chrome';

/**
 * Serves `*.css?inline` the way the bundle does: a Lit `CSSResult` as the default export.
 * @type {import('@web/dev-server').Plugin}
 */
const litCssInline = {
  name: 'brama:lit-css-inline',
  resolveImport({ source, context }) {
    if (!source.endsWith('.css?inline')) return undefined;
    return new URL(source, `http://localhost${context.path}`).pathname + '?inline';
  },
  async serve(context) {
    if (!context.path.endsWith('.css') || !context.URL.searchParams.has('inline')) return undefined;
    const css = await readFile(new URL(`.${context.path}`, import.meta.url), 'utf8');
    return {
      type: 'js',
      body: `import { unsafeCSS } from 'lit';\nexport default unsafeCSS(${JSON.stringify(css)});`,
    };
  },
};

export default {
  files: 'src/**/*.test.js',
  nodeResolve: true,
  browsers: [chromeLauncher({ launchOptions: { channel: 'chrome' } })],
  plugins: [litCssInline],
};
