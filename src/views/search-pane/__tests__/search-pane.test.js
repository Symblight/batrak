import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../search-pane.js';

/** @typedef {import('../search-pane.js').AcpSearchPane} AcpSearchPane */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const OPTIONS = { query: 'needle', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };

describe('acp-search-pane', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string) => unknown} */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      return answer(cmd);
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $workspace.set(null);
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpSearchPane, panel: HTMLElementTagNameMap['acp-search-panel'] }>} */
  async function render(active = true) {
    const el = /** @type {AcpSearchPane} */ (await fixture(html`<acp-search-pane .active=${active}></acp-search-pane>`));
    return { el, panel: /** @type {HTMLElementTagNameMap['acp-search-panel']} */ (el.querySelector('acp-search-panel')) };
  }

  /**
   * @param {Element} from
   * @param {string} type
   * @param {object} detail
   */
  function fire(from, type, detail) {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('searches the project in its own slot for what the panel asks, only while it is the shown pane, and shows the error when a search fails', async () => {
    // Arrange
    const { el, panel } = await render(false);
    /** @type {Event[]} */
    const leaked = [];
    el.addEventListener('acp-search', (e) => leaked.push(e));
    // Act: hidden
    fire(panel, 'acp-search', { options: OPTIONS, delay: 0 });
    await new Promise((r) => setTimeout(r, 30));
    // Assert
    expect(calls.map((c) => c.cmd), 'a hidden pane searches nothing').to.not.include('find_in_files');
    // Act: shown
    answer = (cmd) => {
      if (cmd === 'find_in_files') throw 'bad pattern';
      return null;
    };
    el.active = true;
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    await until(() => panel.error !== '');
    // Assert
    const search = calls.find((c) => c.cmd === 'find_in_files');
    expect(search?.args).to.include({ rootId: 'r', slot: 'panel' });
    expect(search?.args.options).to.deep.equal(OPTIONS);
    expect(panel.error).to.contain('bad pattern');
    expect(leaked, 'handled here').to.deep.equal([]);
  });

  it('opens a match under the project’s path', async () => {
    // Arrange
    const { el, panel } = await render();
    /** @type {CustomEvent[]} */
    const opened = [];
    el.addEventListener('acp-file-open', (e) => opened.push(/** @type {CustomEvent} */ (e)));
    /** @type {Event[]} */
    const leaked = [];
    el.addEventListener('acp-search-panel-open', (e) => leaked.push(e));
    // Act
    fire(panel, 'acp-search-panel-open', { path: 'src/a.js', line: 3, column: 7, length: 3 });
    // Assert
    expect(opened.map((e) => e.detail)).to.deep.equal([{ path: '/p/src/a.js', line: 3, column: 7, length: 3 }]);
    expect(opened[0].bubbles && opened[0].composed).to.equal(true);
    expect(leaked).to.deep.equal([]);
  });

  it('runs a handed-over search with its folder and mask as filters, and focuses the query', async () => {
    // Arrange
    const { el, panel } = await render();
    // Act
    el.show({ query: 'needle', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.ts, !*.test.ts' });
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    // Assert
    expect(calls.find((c) => c.cmd === 'find_in_files')?.args.options).to.deep.equal({
      query: 'needle',
      caseSensitive: true,
      wholeWord: false,
      regex: false,
      include: 'src/**/*.ts',
      exclude: '**/*.test.ts',
    });
    expect(panel.query).to.equal('needle');
    expect(panel.shadowRoot?.activeElement?.localName, 'the query field has the focus').to.equal('md-text-field');
  });
});
