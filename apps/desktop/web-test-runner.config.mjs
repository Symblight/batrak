import { readFile } from 'node:fs/promises';
import { chromeLauncher } from '@web/test-runner-chrome';

/**
 * Serves `bind-event-listener` (Pragmatic drag and drop's, which `@symblight/tree-view` loads), which ships only CommonJS, as ES modules:
 * each `require('./x')` becomes an import, each `exports.x` (or getter on `exports`) an export.
 * @type {import('@web/dev-server').Plugin}
 */
const bindEventListener = {
  name: 'batrak:bind-event-listener',
  transform(context) {
    if (!/\/bind-event-listener\/dist\/[\w-]+\.js$/.test(context.path)) return undefined;
    const body = /** @type {string} */ (context.body);
    const required = [...new Set([...body.matchAll(/require\("(\.\/[\w-]+)"\)/g)].map((m) => m[1]))];
    const names = new Set(
      [...body.matchAll(/exports\.(\w+) = (?!void 0)|defineProperty\(exports, "(\w+)", \{ enumerable/g)].map(
        (m) => m[1] ?? m[2],
      ),
    );
    return [
      ...required.map((path, i) => `import * as __required${i} from '${path}.js';`),
      `const __modules = { ${required.map((path, i) => `'${path}': __required${i}`).join(', ')} };`,
      'const require = (path) => __modules[path];',
      'const exports = {};',
      body,
      // Aliased: the module declares its own `function bind`.
      ...[...names].map((name) => `const __exported_${name} = exports.${name};\nexport { __exported_${name} as ${name} };`),
    ].join('\n');
  },
};

/**
 * Serves `*.css?inline` the way the bundle does: a Lit `CSSResult` as the default export.
 * @type {import('@web/dev-server').Plugin}
 */
const litCssInline = {
  name: 'batrak:lit-css-inline',
  resolveImport({ source, context }) {
    if (!source.endsWith('.css?inline')) return undefined;
    // A package's stylesheet (`@xterm/xterm/css/xterm.css?inline`) is served from node_modules.
    if (source.startsWith('@')) return `/node_modules/${source}`;
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
  name: 'batrak:raw',
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

/**
 * Test files run side by side at one origin, and persisted stores read `localStorage` as they mount:
 * each gets a storage of its own, or one file's saved tabs show up in another.
 */
const OWN_STORAGE = `<script>
  const own = {};
  const hidden = (name, value) => Object.defineProperty(own, name, { value, enumerable: false });
  hidden('getItem', (key) => (Object.hasOwn(own, key) ? own[key] : null));
  hidden('setItem', (key, value) => { own[key] = String(value); });
  hidden('removeItem', (key) => { delete own[key]; });
  hidden('clear', () => { for (const key of Object.keys(own)) delete own[key]; });
  hidden('key', (index) => Object.keys(own)[index] ?? null);
  Object.defineProperty(own, 'length', { get: () => Object.keys(own).length, enumerable: false });
  Object.defineProperty(window, 'localStorage', { value: own });
</script>`;

export default {
  files: 'src/**/*.test.js',
  nodeResolve: true,
  browsers: [
    chromeLauncher({
      launchOptions: { channel: 'chrome' },
      // Each test file in a window of its own: a background tab draws no frames, so xterm (and
      // anything else that renders or observes resizes) would stall while files run in parallel.
      createPage: async ({ browser }) => (await browser.createBrowserContext()).newPage(),
    }),
  ],
  plugins: [litCssInline, rawText, bindEventListener],
  // nanostores reads `process.env.NODE_ENV`, which the bundler defines.
  testRunnerHtml: (testFramework) => `<!doctype html>
    <html><head>${OWN_STORAGE}</head>
      <body>
        <script>window.process = { env: { NODE_ENV: 'test' } };</script>
        <script type="module" src="${testFramework}"></script>
      </body>
    </html>`,
};
