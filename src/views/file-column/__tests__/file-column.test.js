import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $openRoots, $project } from '../../../stores/project/project.js';
import { $sessions, selectSession } from '../../../stores/sessions/sessions.js';
import { $workspaceOpening, $workspaces, setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
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
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    clearMocks();
    setActiveWorkspace('/p', 'main');
    selectSession(null);
    $sessions.set([]);
    $workspaces.set([]);
    $openRoots.set({});
    $workspaceOpening.set(null);
    $project.set(null);
  });

  const render = async () => /** @type {AcpFileColumn} */ (await fixture(html`<acp-file-column></acp-file-column>`));

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
      if (cmd === 'rescan_root') return new Promise((resolve) => (finishScan = () => resolve(null)));
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
    await until(() => calls.some((c) => c.cmd === 'rescan_root'));
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
    expect(calls.filter((c) => c.cmd === 'rescan_root').map((c) => c.args)).to.deep.equal([{ rootId: 'r' }]);
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

  it('shows Search with a handed-over search, which it runs in the Search slot, and the pane searches only while shown', async () => {
    const el = await render();
    const view = /** @type {HTMLElementTagNameMap['acp-search-pane']} */ (el.querySelector('acp-search-pane'));
    expect(/** @type {HTMLElement} */ (view.parentElement).hidden, 'hidden until shown').to.equal(true);
    await el.showSearch({ query: 'needle', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.ts' });
    expect(el.sideView).to.equal('search');
    await until(() => calls.some((c) => c.cmd === 'find_in_files'));
    expect(calls.find((c) => c.cmd === 'find_in_files')?.args).to.include({ rootId: 'r', slot: 'panel' });
    expect(view.active).to.equal(true);
    expect(/** @type {HTMLElement} */ (view.parentElement).hidden).to.equal(false);
    el.showFiles();
    await el.updateComplete;
    expect(view.active).to.equal(false);
    expect(/** @type {HTMLElement} */ (view.parentElement).hidden).to.equal(true);
  });

  it('computes the changes only while the Changes pane is the shown one', async () => {
    const el = await render();
    const view = /** @type {HTMLElementTagNameMap['acp-git-changes']} */ (el.querySelector('acp-git-changes'));
    expect([view.active, /** @type {HTMLElement} */ (view.parentElement).hidden]).to.deep.equal([false, true]);
    el.showChanges();
    await el.updateComplete;
    expect([view.active, /** @type {HTMLElement} */ (view.parentElement).hidden]).to.deep.equal([true, false]);
  });

  it("hides the previous tree while a workspace's root opens, shows a skeleton after 150 ms, then lists its folder", async () => {
    // Arrange
    const el = await render();
    const tree = /** @type {HTMLElementTagNameMap['acp-file-tree']} */ (el.querySelector('acp-file-tree'));
    const shown = () => {
      const root = /** @type {ShadowRoot} */ (tree.shadowRoot);
      return {
        tree: !root.querySelector('tvx-tree-view')?.hidden,
        skeleton: root.querySelector('[role="status"][aria-label="Opening folder"]') !== null,
      };
    };
    setWorkspaces([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/one' })], '/p');
    $sessions.set(/** @type {import('../../../hooks/sessions/types.js').Session[]} */ (/** @type {unknown} */ ([{ id: 'c', projectId: '/p', workspaceId: 'w1' }])));

    // Act: switch to the workspace while its root scans
    $workspaceOpening.set('/wt/one');
    setActiveWorkspace('/p', 'w1');
    await /** @type {HTMLElementTagNameMap['acp-files-view']} */ (el.querySelector('acp-files-view')).updateComplete;
    await tree.updateComplete;

    // Assert
    expect(shown(), 'the tree goes at once, the skeleton waits').to.deep.equal({ tree: false, skeleton: false });
    await until(() => shown().skeleton);

    // Act: its root is open
    calls = [];
    $openRoots.set({ '/wt/one': 'r-w' });
    $workspaceOpening.set(null);
    await until(() => calls.some((c) => c.cmd === 'list_dir'));

    // Assert
    expect(shown()).to.deep.equal({ tree: true, skeleton: false });
    expect(calls.find((c) => c.cmd === 'list_dir')?.args, 'its entries, under no root row').to.deep.include({ rootId: 'r-w', path: '' });
  });
});
