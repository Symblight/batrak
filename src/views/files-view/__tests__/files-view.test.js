import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { projects } from '../../../hooks/projects/projects.js';
import { sessions } from '../../../hooks/sessions/sessions.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $projectExpandedFolders, setExpandedFolders } from '../../../stores/file-tree/file-tree.js';
import { $sessionRoot, $sessionRootOpening } from '../../../stores/session-root/session-root.js';
import { $openingPath, $workspace } from '../../../stores/workspace/workspace.js';
import '../files-view.js';

/** @typedef {import('../files-view.js').AcpFilesView} AcpFilesView */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Emits `change` again until `heard()`: the listeners register asynchronously, so an early emit is lost.
 * @param {object} change
 * @param {() => boolean} heard
 */
async function emitUntil(change, heard) {
  const started = Date.now();
  while (!heard()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await emit('roots://changed', change);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** @param {string} rootId @param {string[]} dirs */
const change = (rootId, dirs) => ({ rootId, dirs, added: [], removed: [], modified: [], git: false });

describe('acp-files-view', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
        return cmd === 'list_dir' ? [] : null;
      },
      { shouldMockEvents: true },
    );
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $projectExpandedFolders.setKey('/p', undefined);
    $sessionRoot.set(null);
    $sessionRootOpening.set(false);
    $openingPath.set(null);
    $workspace.set(null);
    $notices.set([]);
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpFilesView, tree: HTMLElementTagNameMap['acp-file-tree'] }>} */
  async function render() {
    const el = /** @type {AcpFilesView} */ (await fixture(html`<acp-files-view></acp-files-view>`));
    return { el, tree: /** @type {HTMLElementTagNameMap['acp-file-tree']} */ (el.querySelector('acp-file-tree')) };
  }

  it('lists the project’s folder, or the shown worktree session’s, with its expanded folders and whether one is opening', async () => {
    // Arrange
    const { el, tree } = await render();
    // Assert
    expect([tree.rootId, tree.root, tree.rootLabel, tree.opening]).to.deep.equal(['r', '/p', null, false]);
    // Act
    setExpandedFolders(['src']);
    $sessionRoot.set({ sessionId: 's1', rootId: 'wt', path: '/wt/s1', label: 'brama/s1' });
    $sessionRootOpening.set(true);
    await el.updateComplete;
    // Assert
    expect([tree.rootId, tree.root, tree.rootLabel, tree.opening], 'a session folder opening').to.deep.equal(['wt', '/wt/s1', 'brama/s1', true]);
    // Act
    $sessionRootOpening.set(false);
    $openingPath.set('/q');
    await el.updateComplete;
    // Assert
    expect(tree.opening, 'a project opening').to.equal(true);
    expect(tree.expanded, 'a worktree with none of its own shows the project’s').to.deep.equal(['src']);
    expect(tree.listDir === projects.listDir, 'lists folders through the projects hook').to.equal(true);
  });

  it('keeps the folders the user expands, without the event leaving the view', async () => {
    // Arrange
    const { el, tree } = await render();
    /** @type {Event[]} */
    const leaked = [];
    el.addEventListener('acp-expanded-change', (e) => leaked.push(e));
    // Act
    tree.dispatchEvent(new CustomEvent('acp-expanded-change', { detail: { paths: ['src', 'src/a'] }, bubbles: true, composed: true }));
    // Assert
    expect($projectExpandedFolders.get()['/p']).to.deep.equal(['src', 'src/a']);
    expect(leaked).to.deep.equal([]);
  });

  it('lists folders again where files changed on disk: the project’s, or the shown worktree session’s, and not once it is gone', async () => {
    // Arrange
    const { el, tree } = await render();
    /** @type {string[][]} */
    const reloaded = [];
    tree.reload = (dirs) => reloaded.push(dirs);
    /** A second view stays up to tell when an event has been delivered to every listener. @type {string[][]} */
    const sentinel = [];
    const other = await render();
    other.tree.reload = (dirs) => sentinel.push(dirs);
    // Act: the project's folder
    await emitUntil(change('r', ['', 'src']), () => reloaded.length > 0);
    // Assert
    expect(reloaded.every((dirs) => dirs.join() === ',src')).to.equal(true);
    // Act: gone. Its unsubscribing takes a moment, so count from the second event the other view hears.
    el.remove();
    sentinel.length = 0;
    await emitUntil(change('r', ['late']), () => sentinel.length >= 2);
    const settled = reloaded.length;
    await emitUntil(change('r', ['late']), () => sentinel.length >= 5);
    // Assert
    expect(reloaded.length, 'a removed view hears nothing').to.equal(settled);
  });

  it('lists folders again where the shown worktree session’s files changed, and not for the project’s', async () => {
    // Arrange
    sessions.followRoot();
    $sessionRoot.set({ sessionId: 's1', rootId: 'wt', path: '/wt/s1', label: 'brama/s1' });
    const { tree } = await render();
    /** @type {string[][]} */
    const reloaded = [];
    tree.reload = (dirs) => reloaded.push(dirs);
    // Act: the project's change arrives first, then the session's
    await emit('roots://changed', change('r', ['src']));
    await emitUntil(change('wt', ['lib']), () => reloaded.length > 0);
    // Assert
    expect(reloaded.every((dirs) => dirs.join() === 'lib'), 'only the session folder’s').to.equal(true);
  });

  it('refreshes by scanning the root again, then listing the root and the expanded folders; one refresh at a time', async () => {
    // Arrange
    const { el, tree } = await render();
    // The empty fake folder makes the tree report 'src' as gone; keep what was stored.
    el.addEventListener('acp-expanded-change', (e) => e.stopImmediatePropagation(), true);
    setExpandedFolders(['src']);
    await el.updateComplete;
    /** @type {string[][]} */
    const reloaded = [];
    tree.reload = (dirs) => reloaded.push(dirs);
    // Act
    const first = el.refresh();
    const second = el.refresh();
    await Promise.all([first, second]);
    // Assert
    expect(calls.filter((c) => c.cmd === 'rescan_root').map((c) => c.args)).to.deep.equal([{ rootId: 'r' }]);
    expect(reloaded).to.deep.equal([['', 'src']]);
    // Act: once it is done, the next one runs
    await el.refresh();
    // Assert
    expect(calls.filter((c) => c.cmd === 'rescan_root')).to.have.length(2);
  });

  it('says so when the scan fails, lists nothing again, and can be tried again', async () => {
    // Arrange
    let failing = true;
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
        if (cmd === 'rescan_root' && failing) throw 'disk gone';
        return cmd === 'list_dir' ? [] : null;
      },
      { shouldMockEvents: true },
    );
    const { el, tree } = await render();
    /** @type {string[][]} */
    const reloaded = [];
    tree.reload = (dirs) => reloaded.push(dirs);
    // Act
    await el.refresh();
    // Assert
    expect(reloaded).to.deep.equal([]);
    expect($notices.get().map((n) => n.message)).to.deep.equal(['Refresh failed: disk gone']);
    // Act
    failing = false;
    await el.refresh();
    // Assert
    expect(reloaded).to.deep.equal([['']]);
  });

  it('does not list a root again when another one is listed by the time its scan ends', async () => {
    // Arrange
    /** @type {() => void} */
    let finishScan = () => {};
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
        if (cmd === 'rescan_root') return new Promise((resolve) => (finishScan = () => resolve(null)));
        return cmd === 'list_dir' ? [] : null;
      },
      { shouldMockEvents: true },
    );
    const { el, tree } = await render();
    /** @type {string[][]} */
    const reloaded = [];
    tree.reload = (dirs) => reloaded.push(dirs);
    // Act
    const refreshing = el.refresh();
    await until(() => calls.some((c) => c.cmd === 'rescan_root'));
    $workspace.set({ path: '/q', name: 'q', rootId: 'r2' });
    finishScan();
    await refreshing;
    // Assert
    expect(reloaded).to.deep.equal([]);
  });

  it('reveals a file in the tree', async () => {
    // Arrange
    const { el, tree } = await render();
    /** @type {unknown[]} */
    const revealed = [];
    tree.reveal = (rel, options) => revealed.push([rel, options]);
    // Act
    el.reveal('src/a.js', { expand: true });
    // Assert
    expect(revealed).to.deep.equal([['src/a.js', { expand: true }]]);
  });
});
