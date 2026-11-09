import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { git } from '../../../hooks/git/git.js';
import { projects } from '../../../hooks/projects/projects.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $folderExpandedFolders, setExpandedFolders } from '../../../stores/file-tree/file-tree.js';
import { $openRoots, $openingPath, $project } from '../../../stores/project/project.js';
import { $sessions, selectSession } from '../../../stores/sessions/sessions.js';
import { $workspaceOpening, $workspaces, setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
import { $terminals, removeProjectTerminals } from '../../../stores/terminals/terminals.js';
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

/** Shows a chat of workspace `/wt/s1`, whose root is `rootId` once open (`null`: scanning). @param {string | null} rootId */
function showWorkspace(rootId) {
  setWorkspaces([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/s1' })], '/p');
  $sessions.set(/** @type {import('../../../hooks/sessions/types.js').Session[]} */ (/** @type {unknown} */ ([{ id: 'c', projectId: '/p', workspaceId: 'w1' }])));
  $openRoots.set(rootId === null ? {} : { '/wt/s1': rootId });
  $workspaceOpening.set(rootId === null ? '/wt/s1' : null);
  setActiveWorkspace('/p', 'w1');
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
        if (cmd === 'git_status') return { version: 1, unchanged: true, status: null };
        return cmd === 'list_dir' ? [] : null;
      },
      { shouldMockEvents: true },
    );
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $folderExpandedFolders.setKey('/p', undefined);
    setActiveWorkspace('/p', 'main');
    selectSession(null);
    $sessions.set([]);
    $workspaces.set([]);
    $openRoots.set({});
    $workspaceOpening.set(null);
    $openingPath.set(null);
    $project.set(null);
    $notices.set([]);
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpFilesView, tree: HTMLElementTagNameMap['acp-file-tree'] }>} */
  async function render() {
    const el = /** @type {AcpFilesView} */ (await fixture(html`<acp-files-view></acp-files-view>`));
    return { el, tree: /** @type {HTMLElementTagNameMap['acp-file-tree']} */ (el.querySelector('acp-file-tree')) };
  }

  it('lists the project’s folder, or the shown workspace’s, with its expanded folders and whether one is opening', async () => {
    // Arrange
    const { el, tree } = await render();
    // Assert
    expect([tree.rootId, tree.root, tree.opening]).to.deep.equal(['r', '/p', false]);
    // Act
    setExpandedFolders(['src']);
    showWorkspace(null);
    await el.updateComplete;
    // Assert
    expect([tree.rootId, tree.root, tree.opening], 'a workspace folder opening').to.deep.equal([null, '/wt/s1', true]);
    // Act
    showWorkspace('wt');
    $openingPath.set('/q');
    await el.updateComplete;
    // Assert
    expect(tree.opening, 'a project opening').to.equal(true);
    expect(tree.rootId, 'its root, once open').to.equal('wt');
    expect(tree.expanded, 'a workspace with none of its own shows the project’s').to.deep.equal(['src']);
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
    expect($folderExpandedFolders.get()['/p']).to.deep.equal(['src', 'src/a']);
    expect(leaked).to.deep.equal([]);
  });

  it('lists folders again where files changed on disk, and not once it is gone', async () => {
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

  it('lists folders again where the shown workspace’s files changed, and not for the project’s', async () => {
    // Arrange
    showWorkspace('wt');
    const { tree } = await render();
    /** @type {string[][]} */
    const reloaded = [];
    tree.reload = (dirs) => reloaded.push(dirs);
    // Act: the project's change arrives first, then the session's
    await emit('roots://changed', change('r', ['src']));
    await emitUntil(change('wt', ['lib']), () => reloaded.length > 0);
    // Assert
    expect(reloaded.every((dirs) => dirs.join() === 'lib'), 'only the workspace folder’s').to.equal(true);
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
    $project.set({ path: '/q', name: 'q', rootId: 'r2' });
    finishScan();
    await refreshing;
    // Assert
    expect(reloaded).to.deep.equal([]);
  });

  it('carries out what the tree asks for a row: show it, a terminal there, copy its path', async () => {
    // Arrange
    const { el, tree } = await render();
    const original = navigator.clipboard.writeText;
    /** @type {string[]} */
    const copied = [];
    navigator.clipboard.writeText = async (text) => void copied.push(text);
    /** @type {string[]} */
    const escaped = [];
    const parent = /** @type {HTMLElement} */ (el.parentElement);
    const note = (/** @type {Event} */ e) => escaped.push(e.type);
    const types = ['acp-reveal-path', 'acp-open-terminal', 'acp-copy'];
    for (const type of types) parent.addEventListener(type, note);
    /** @param {string} type @param {object} detail */
    const ask = (type, detail) => tree.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

    try {
      // Act
      ask('acp-reveal-path', { path: '/p/a.txt' });
      ask('acp-open-terminal', { path: '/p/src' });
      ask('acp-copy', { text: '/p/a.txt' });

      // Assert
      expect(calls.filter((c) => c.cmd === 'reveal_path').map((c) => c.args)).to.deep.equal([{ path: '/p/a.txt' }]);
      expect(Object.values($terminals.get()).map((t) => t.cwd)).to.deep.equal(['/p/src']);
      expect(copied).to.deep.equal(['/p/a.txt']);
      expect(escaped, 'answered here, not again by a column').to.deep.equal([]);
    } finally {
      navigator.clipboard.writeText = original;
      for (const type of types) parent.removeEventListener(type, note);
      removeProjectTerminals('/p');
    }
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

  it('keeps the changed files current only while it is connected', async () => {
    // Arrange
    const scanned = () => calls.some((c) => c.cmd === 'git_status');
    // Act
    const { el } = await render();
    // Assert
    await until(scanned);
    // Act
    el.remove();
    calls.length = 0;
    git.refreshChanges();
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(scanned(), 'removed').to.equal(false);
  });
});
