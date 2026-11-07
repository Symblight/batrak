import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { git } from '../../../hooks/git/git.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $commitSelection, $gitChanges, $gitCompare, $gitRepo, NO_COMPARE } from '../../../stores/git/git.js';
import { $openRoots, $project } from '../../../stores/project/project.js';
import { setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
import '../git-changes.js';

/** @typedef {import('../git-changes.js').AcpGitChanges} AcpGitChanges */
/** @typedef {import('../../../hooks/git/types.js').GitFileStatus} GitFileStatus */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** @param {string} path @returns {GitFileStatus} */
const file = (path) => ({ path, kind: 'modified', staged: false, unstaged: true, origPath: null, added: 1, removed: 0 });
const CHANGES = { files: [file('a.js'), file('b.js')], loaded: true, loading: false, error: null };
/** @type {import('../../../hooks/git/types.js').GitRepoView} */
const REPO = { repo: { branch: 'main', sha: 'abc', detached: false, upstream: null, ahead: 0, behind: 0, upstreamSha: null, remote: null }, error: null };

describe('acp-git-changes', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string) => unknown} */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = (cmd) => (cmd === 'git_status' ? { version: 1, unchanged: true, status: null } : null);
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      return answer(cmd);
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $gitChanges.set(CHANGES);
    $gitRepo.set(REPO);
  });

  afterEach(() => {
    $commitSelection.set(new Set());
    setActiveWorkspace('/p', 'main');
    setWorkspaces([], null);
    $openRoots.set({});
    $notices.set([]);
    $project.set(null);
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpGitChanges, panel: HTMLElementTagNameMap['acp-changes-panel'] }>} */
  async function render(active = false) {
    const el = /** @type {AcpGitChanges} */ (await fixture(html`<acp-git-changes .active=${active}></acp-git-changes>`));
    return { el, panel: /** @type {HTMLElementTagNameMap['acp-changes-panel']} */ (el.querySelector('acp-changes-panel')) };
  }

  /**
   * @param {Element} from
   * @param {string} type
   * @param {object} [detail]
   */
  function fire(from, type, detail) {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('while comparing, gives the panel the branch’s files and leaves the picks of local files alone', async () => {
    // Arrange
    const { el, panel } = await render();
    $commitSelection.set(new Set(['a.js']));
    const compared = { files: [], loaded: true, loading: false, error: null };
    // Act
    $gitCompare.set({ target: 'main', base: 'b1', changes: compared, refreshError: 'slow' });
    await el.updateComplete;
    const during = { changes: panel.changes === compared, compareTo: panel.compareTo, refreshError: panel.refreshError };
    $gitCompare.set(NO_COMPARE);
    await el.updateComplete;
    // Assert
    expect(during).to.deep.equal({ changes: true, compareTo: 'main', refreshError: 'slow' });
    expect([...$commitSelection.get()]).to.deep.equal(['a.js']);
    expect([panel.changes === CHANGES, panel.compareTo]).to.deep.equal([true, null]);
  });

  it('in a worktree session, gives the panel the worktree as its root, so its file clicks resolve there', async () => {
    // Arrange
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    setWorkspaces([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/s1' })], '/p');
    $openRoots.set({ '/wt/s1': 'r-w' });
    setActiveWorkspace('/p', 'w1');
    // Act
    const { panel } = await render();
    // Assert
    expect(panel.root).to.equal('/wt/s1');
  });

  it('gives the panel the changed files, the repository, the picks and the project folder; picks of files no longer changed are forgotten once the scan is done', async () => {
    // Arrange
    const { el, panel } = await render();
    // Assert
    expect([panel.changes === CHANGES, panel.repo === REPO, panel.root]).to.deep.equal([true, true, '/p']);
    // Act
    $commitSelection.set(new Set(['a.js', 'b.js']));
    $gitChanges.set({ files: [], loaded: false, loading: true, error: null });
    await el.updateComplete;
    // Assert
    expect([...panel.selection].sort(), 'not while a scan is pending').to.deep.equal(['a.js', 'b.js']);
    // Act
    $gitChanges.set({ files: [file('b.js')], loaded: true, loading: false, error: null });
    await el.updateComplete;
    // Assert
    expect([...$commitSelection.get()]).to.deep.equal(['b.js']);
    expect([...panel.selection]).to.deep.equal(['b.js']);
  });

  it('computes the changes only while it is the shown pane, from its first showing', async () => {
    // Arrange: it comes up already shown, then is hidden
    const first = await render(true);
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    first.el.active = false;
    await first.el.updateComplete;
    calls.length = 0;
    git.refreshChanges();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.map((c) => c.cmd), 'hidden after being shown at once').to.not.include('git_status');
    first.el.remove();
    // Arrange
    const { el } = await render(false);
    await new Promise((r) => setTimeout(r, 30));
    // Assert
    expect(calls.map((c) => c.cmd), 'hidden').to.not.include('git_status');
    // Act
    el.active = true;
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    calls.length = 0;
    el.active = false;
    await el.updateComplete;
    git.refreshChanges();
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(calls.map((c) => c.cmd), 'hidden again').to.not.include('git_status');
    // Act: shown, then gone
    el.active = true;
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    el.remove();
    calls.length = 0;
    git.refreshChanges();
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(calls.map((c) => c.cmd), 'removed').to.not.include('git_status');
  });

  it('turns the panel’s select and refresh into picks and a scan, and passes opening a diff on', async () => {
    // Arrange
    const { el, panel } = await render(true);
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-commit-select', 'acp-changes-refresh']) el.addEventListener(type, (e) => leaked.push(e));
    /** @type {CustomEvent[]} */
    const diffs = [];
    el.addEventListener('acp-diff-open', (e) => diffs.push(/** @type {CustomEvent} */ (e)));
    // Act
    fire(panel, 'acp-commit-select', { ids: ['a.js'] });
    calls.length = 0;
    fire(panel, 'acp-changes-refresh');
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    fire(panel, 'acp-diff-open', { path: 'a.js' });
    // Assert
    expect([...$commitSelection.get()]).to.deep.equal(['a.js']);
    expect(diffs.map((e) => e.detail)).to.deep.equal([{ path: 'a.js' }]);
    expect(leaked).to.deep.equal([]);
  });

  it('asks before rolling back the picked files, rolls back only those on yes, and unpicks them', async () => {
    // Arrange
    $commitSelection.set(new Set(['a.js']));
    const { el, panel } = await render();
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (el.querySelector('acp-confirm-dialog'));
    /** @type {string[]} */
    const asked = [];
    let yes = false;
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return yes;
    };
    const rollbacks = () => calls.filter((c) => c.cmd === 'git_revert_files').map((c) => c.args.paths);
    // Act
    fire(panel, 'acp-changes-rollback');
    await until(() => asked.length === 1);
    await new Promise((r) => setTimeout(r));
    const afterNo = rollbacks();
    yes = true;
    fire(panel, 'acp-changes-rollback');
    await until(() => $commitSelection.get().size === 0);
    // Assert
    expect(afterNo).to.deep.equal([]);
    expect(asked).to.deep.equal(['Revert a.js?', 'Revert a.js?']);
    expect(rollbacks()).to.deep.equal([['a.js']]);
  });

  it('commits the picked files and says how it went; Amend starts from the last commit’s message', async () => {
    // Arrange
    const { el, panel } = await render();
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-amend-start', 'acp-commit']) el.addEventListener(type, (e) => leaked.push(e));
    /** @type {boolean[]} */
    const finished = [];
    panel.commitFinished = (succeeded) => finished.push(succeeded);
    /** @type {(string | null)[]} */
    const filled = [];
    panel.fillAmendMessage = (message) => filled.push(message);
    answer = (cmd) => (cmd === 'git_commit' ? { sha: 'abc1234', summary: 'Fix it' } : cmd === 'git_last_commit_message' ? 'Last one' : null);
    // Act
    fire(panel, 'acp-amend-start');
    fire(panel, 'acp-commit', { paths: ['a.js'], message: 'Fix it', amend: false });
    await until(() => finished.length === 1 && filled.length === 1);
    // Assert
    expect(filled).to.deep.equal(['Last one']);
    expect(calls.find((c) => c.cmd === 'git_commit')?.args).to.deep.equal({ rootId: 'r', paths: ['a.js'], message: 'Fix it', amend: false });
    expect(finished).to.deep.equal([true]);
    expect($notices.get().map((n) => [n.level, n.message, n.timeout])).to.deep.equal([['info', 'Committed abc1234', 4000]]);
    // Act: a hook refuses
    answer = (cmd) => {
      if (cmd === 'git_commit') throw 'pre-commit failed';
      return null;
    };
    fire(panel, 'acp-commit', { paths: ['a.js'], message: 'Again', amend: true });
    await until(() => finished.length === 2);
    // Assert
    expect(finished).to.deep.equal([true, false]);
    expect($notices.get().at(-1)).to.deep.include({ level: 'error', message: 'Commit failed: pre-commit failed' });
    // Act: an amend that works, and the last message can't be read
    answer = (cmd) => {
      if (cmd === 'git_last_commit_message') throw 'no commits';
      return cmd === 'git_commit' ? { sha: 'def5678', summary: 'Reworded' } : null;
    };
    fire(panel, 'acp-amend-start');
    fire(panel, 'acp-commit', { paths: [], message: 'Reworded', amend: true });
    await until(() => finished.length === 3 && filled.length === 2);
    // Assert
    expect(filled.at(-1), 'nothing to start from').to.equal(null);
    expect($notices.get().at(-1)?.message).to.equal('Amended def5678');
    expect(leaked).to.deep.equal([]);
  });
});
