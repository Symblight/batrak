import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../acp-file-column.js';

/** @typedef {import('../acp-file-column.js').AcpFileColumn} AcpFileColumn */

/** @type {{ cmd: string, args: Record<string, unknown> }[]} */
let calls = [];

/**
 * Polls until `pred` holds; fails after 2s.
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('acp-file-column', () => {
  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args) });
      return cmd === 'list_dir' ? [] : null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    clearMocks();
    $workspace.set(null);
  });

  const render = async () => /** @type {AcpFileColumn} */ (await fixture(html`<acp-file-column></acp-file-column>`));
  /** @param {AcpFileColumn} el */
  const panel = (el) => /** @type {HTMLElementTagNameMap['acp-search-panel']} */ (el.shadowRoot?.querySelector('acp-search-panel'));

  it("opens a search match under the project's path", async () => {
    const el = await render();
    /** @type {CustomEvent[]} */
    const opened = [];
    el.addEventListener('acp-file-open', (e) => opened.push(/** @type {CustomEvent} */ (e)));
    panel(el).dispatchEvent(
      new CustomEvent('acp-search-panel-open', {
        detail: { path: 'src/a.js', line: 3, column: 7, length: 3 },
        bubbles: true,
        composed: true,
      }),
    );
    expect(opened.map((e) => e.detail)).to.deep.equal([{ path: '/p/src/a.js', line: 3, column: 7, length: 3 }]);
    expect(opened[0].bubbles && opened[0].composed).to.equal(true);
  });

  it('shows Search with a handed-over search, its folder and mask as filters', async () => {
    const el = await render();
    await el.showSearch({ query: 'needle', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.ts, !*.test.ts' });
    expect(el.sideView).to.equal('search');
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    const search = calls.find((c) => c.cmd === 'find_in_files');
    expect(search?.args).to.include({ rootId: 'r', slot: 'panel' });
    expect(search?.args.options).to.deep.equal({
      query: 'needle',
      caseSensitive: true,
      wholeWord: false,
      regex: false,
      include: 'src/**/*.ts',
      exclude: '**/*.test.ts',
    });
  });
});
