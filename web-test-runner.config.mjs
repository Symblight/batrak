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

/**
 * Serves `*?raw` (SVG icons) the way the bundle does: the file's text as the default export.
 * @type {import('@web/dev-server').Plugin}
 */
const rawText = {
  name: 'brama:raw',
  resolveImport({ source }) {
    // Rewritten to a `?raw` URL of its own path, so node resolution doesn't drop the query.
    if (!source.endsWith('?raw') || !source.startsWith('@')) return undefined;
    return `/node_modules/${source}`;
  },
  async serve(context) {
    if (!context.URL.searchParams.has('raw')) return undefined;
    const text = await readFile(new URL(`.${context.path}`, import.meta.url), 'utf8');
    return { type: 'js', body: `export default ${JSON.stringify(text)};` };
  },
};

export default {
  files: 'src/**/*.test.js',
  nodeResolve: true,
  browsers: [chromeLauncher({ launchOptions: { channel: 'chrome' } })],
  plugins: [litCssInline, rawText],
  // nanostores reads `process.env.NODE_ENV`, which the bundler defines.
  testRunnerHtml: (testFramework) => `<!doctype html>
    <html>
      <body>
        <script>window.process = { env: { NODE_ENV: 'test' } };</script>
        <script type="module" src="${testFramework}"></script>
      </body>
    </html>`,
};
