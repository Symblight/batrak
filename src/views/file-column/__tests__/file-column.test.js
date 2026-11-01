import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../file-column.js';

/** @typedef {import('../file-column.js').AcpFileColumn} AcpFileColumn */

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
  const panel = (el) => /** @type {HTMLElementTagNameMap['acp-search-panel']} */ (el.querySelector('acp-search-panel'));

  it("titles its panel by the shown pane and offers a refresh only for the project's files", async () => {
    const el = await render();
    const header = () => /** @type {HTMLElementTagNameMap['acp-panel-header']} */ (el.querySelector('acp-panel-header'));
    expect(header().heading).to.equal('Files');
    expect(header().action?.label).to.equal('Refresh files');
    el.sideView = 'changes';
    await el.updateComplete;
    expect(header().heading).to.equal('Changes');
    expect(header().action).to.equal(null);
  });

  it('refreshes the files from its header while disabling the action, and reveals a path in the tree', async () => {
    // Arrange
    /** @type {() => void} */
    let finishScan = () => {};
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args) });
      if (cmd === 'rescan_workspace') return new Promise((resolve) => (finishScan = () => resolve(null)));
      return cmd === 'list_dir' ? [] : null;
    });
    const el = await render();
    const header = /** @type {HTMLElementTagNameMap['acp-panel-header']} */ (el.querySelector('acp-panel-header'));
    const view = /** @type {HTMLElementTagNameMap['acp-files-view']} */ (el.querySelector('acp-files-view'));
    /** @type {unknown[]} */
    const revealed = [];
    view.reveal = (rel, options) => revealed.push([rel, options]);
    // Act
    header.dispatchEvent(new CustomEvent('acp-panel-header-action', { bubbles: true, composed: true }));
    await until(() => calls.some((c) => c.cmd === 'rescan_workspace'));
    await el.updateComplete;
    // Assert
    expect(header.hasAttribute('action-disabled'), 'while it runs').to.equal(true);
    // Act: asked again meanwhile
    header.dispatchEvent(new CustomEvent('acp-panel-header-action', { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    // Assert
    expect(header.hasAttribute('action-disabled'), 'a second ask does not end the first').to.equal(true);
    // Act
    finishScan();
    await until(() => {
      return !header.hasAttribute('action-disabled');
    });
    // Assert
    expect(calls.filter((c) => c.cmd === 'rescan_workspace').map((c) => c.args)).to.deep.equal([{ rootId: 'r' }]);
    // Act: from another pane
    el.sideView = 'changes';
    await el.reveal('src/a.js', { expand: true });
    // Assert
    expect(el.sideView).to.equal('files');
    expect(revealed).to.deep.equal([['src/a.js', { expand: true }]]);
  });

  it('hides the Files pane behind Search and Changes without dropping its view', async () => {
    // Arrange
    const el = await render();
    const view = el.querySelector('acp-files-view');
    const pane = /** @type {HTMLElement} */ (el.querySelector('acp-pane'));
    // Act
    el.sideView = 'search';
    await el.updateComplete;
    // Assert
    expect(pane.hidden).to.equal(true);
    expect(el.querySelector('acp-files-view') === view, 'the same view').to.equal(true);
    // Act
    el.showFiles();
    await el.updateComplete;
    // Assert
    expect(pane.hidden).to.equal(false);
  });

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
