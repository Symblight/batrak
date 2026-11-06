import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fileBytes, fixture, html } from '../../../../test/fixture.js';
import { git } from '../../../hooks/git/git.js';
import { $commentFocus, $comments, $tabComments } from '../../../stores/comments/comments.js';
import { closeAllTabs, openChanges, openSettings } from '../../../stores/editor/editor.js';
import { $commitSelection, $diffLayout, $gitChanges, $gitCompare, $gitRepo, NO_COMPARE } from '../../../stores/git/git.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $openRoots, $project } from '../../../stores/project/project.js';
import { $rootId, setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
import { AcpChangesReview } from '../../../components/changes-review/changes-review.js';
import '../changes-tab.js';

/** @typedef {import('../changes-tab.js').AcpChangesTab} AcpChangesTab */
/** @typedef {import('../../../hooks/git/types.js').GitFileStatus} GitFileStatus */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** @type {GitFileStatus[]} */
const FILES = [
  { path: 'a.js', kind: 'modified', staged: false, unstaged: true, origPath: null, added: 1, removed: 0 },
  { path: 'b.js', kind: 'added', staged: false, unstaged: true, origPath: null, added: 2, removed: 0 },
];
const CHANGES = { files: FILES, loaded: true, loading: false, error: null };
/** @type {import('../../../hooks/git/types.js').GitRepoView} */
const REPO = { repo: { branch: 'main', sha: 'abc', detached: false, upstream: null, ahead: 0, behind: 0, upstreamSha: null, remote: null }, error: null };

describe('acp-changes-tab', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      if (cmd === 'git_status') return { version: 1, unchanged: true, status: null };
      if (cmd === 'read_file') return fileBytes('new text');
      if (cmd === 'git_file_at_head' || cmd === 'git_file_at_rev') return 'old text';
      return null;
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r1' });
    $gitChanges.set(CHANGES);
    $gitRepo.set(REPO);
    // The Changes tab is open, but another tab is active: nothing watches the working tree yet.
    openChanges();
    openSettings();
  });

  afterEach(() => {
    $gitCompare.set(NO_COMPARE);
    setActiveWorkspace('/p', 'main');
    setWorkspaces([], null);
    $openRoots.set({});
    closeAllTabs();
    $commitSelection.set(new Set());
    $comments.set({});
    $commentFocus.set(null);
    $project.set(null);
    $diffLayout.set('unified');
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpChangesTab, review: HTMLElementTagNameMap['acp-changes-review'] }>} */
  async function render() {
    const el = /** @type {AcpChangesTab} */ (await fixture(html`<acp-changes-tab></acp-changes-tab>`));
    return { el, review: /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review')) };
  }

  /**
   * @param {Element} from
   * @param {string} type
   * @param {object} [detail]
   */
  function fire(from, type, detail) {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('asks before reverting a file, reverts it only on yes, and shows why when it fails', async () => {
    // Arrange
    $notices.set([]);
    $gitChanges.set(CHANGES);
    const { el, review } = await render();
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (el.querySelector('acp-confirm-dialog'));
    /** @type {string[]} */
    const asked = [];
    let answer = false;
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return answer;
    };
    const reverts = () => calls.filter((c) => c.cmd === 'git_revert_files').map((c) => c.args.paths);
    // Act
    fire(review, 'acp-change-revert', { id: 'a.js' });
    await until(() => asked.length === 1);
    await new Promise((r) => setTimeout(r));
    const afterNo = reverts();
    answer = true;
    fire(review, 'acp-change-revert', { id: 'b.js' });
    await until(() => reverts().length === 1);
    // Assert
    expect(afterNo).to.deep.equal([]);
    expect(asked).to.deep.equal(['Revert a.js?', 'Delete new file b.js?']);
    expect(reverts()).to.deep.equal([['b.js']]);
    // Arrange: git refuses
    clearMocks();
    mockIPC((cmd) => {
      if (cmd === 'git_revert_files') throw new Error('it has a conflict');
      return cmd === 'git_status' ? { version: 1, unchanged: true, status: null } : null;
    });
    // Act
    fire(review, 'acp-change-revert', { id: 'a.js' });
    await until(() => $notices.get().length === 1);
    // Assert
    expect($notices.get()[0].message).to.equal('Couldn’t revert a.js: it has a conflict');
  });

  it('asks before rolling back the picked files, rolls back only those on yes and unpicks them, keeps them picked when it fails', async () => {
    // Arrange
    $notices.set([]);
    const third = { ...FILES[0], path: 'c.js' };
    $gitChanges.set({ ...CHANGES, files: [...FILES, third] });
    $commitSelection.set(new Set(['a.js', 'b.js']));
    const { el, review } = await render();
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (el.querySelector('acp-confirm-dialog'));
    /** @type {string[]} */
    const asked = [];
    let answer = false;
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return answer;
    };
    const rollbacks = () => calls.filter((c) => c.cmd === 'git_revert_files').map((c) => c.args.paths);
    // Act
    fire(review, 'acp-changes-rollback', undefined);
    await until(() => asked.length === 1);
    await new Promise((r) => setTimeout(r));
    const afterNo = rollbacks();
    answer = true;
    fire(review, 'acp-changes-rollback', undefined);
    await until(() => $commitSelection.get().size === 0);
    // Assert
    expect(afterNo).to.deep.equal([]);
    expect(asked).to.deep.equal(['Roll back 2 files?', 'Roll back 2 files?']);
    expect(rollbacks()).to.deep.equal([['a.js', 'b.js']]);
    // Arrange: git refuses
    $commitSelection.set(new Set(['a.js', 'b.js']));
    clearMocks();
    mockIPC((cmd) => {
      if (cmd === 'git_revert_files') throw new Error('a.js has a conflict');
      return cmd === 'git_status' ? { version: 1, unchanged: true, status: null } : null;
    });
    // Act
    fire(review, 'acp-changes-rollback', undefined);
    await until(() => $notices.get().length === 1);
    // Assert
    expect($notices.get()[0].message).to.equal('Couldn’t revert 2 files: a.js has a conflict');
    expect([...$commitSelection.get()]).to.deep.equal(['a.js', 'b.js']);
  });

  it('scans again, even with nothing seen changing, when the review asks for a refresh', async () => {
    // Arrange
    const { review } = await render();
    openChanges();
    const statuses = () => calls.filter((c) => c.cmd === 'git_status');
    await until(() => statuses().length === 1);
    let leaked = false;
    document.addEventListener('acp-changes-refresh', () => (leaked = true), { once: true });
    // Act
    fire(review, 'acp-changes-refresh');
    await until(() => statuses().length === 2);
    // Assert
    expect(statuses()[1].args.force).to.equal(true);
    expect(leaked).to.equal(false);
  });

  describe('comparing to a branch', () => {
    const compareTo = (/** @type {string} */ target, /** @type {string | null} */ base, /** @type {GitFileStatus[]} */ files) =>
      $gitCompare.set({ target, base, changes: { files, loaded: base !== null, loading: false, error: null }, refreshError: null });
    const until = async (/** @type {() => boolean} */ pred) => {
      const started = Date.now();
      while (!pred()) {
        expect(Date.now() - started, 'timed out').to.be.lessThan(1500);
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    it('shows the branch’s files with diffs against the merge base, and lists comments on them', async () => {
      // Arrange
      const branchFile = /** @type {GitFileStatus} */ ({ ...FILES[0], path: 'branch.js' });
      const thread = /** @type {never} */ ({ id: 't1', line: 1, comments: [{ id: 'c1', body: 'Why?' }] });
      $comments.set({ '/p/branch.js': [thread], '/p/a.js': [thread] });
      compareTo('main', 'b1', [branchFile]);
      openChanges();
      const { el, review } = await render();
      const listed = $tabComments.get().map((c) => c.path);
      $comments.set({});
      // Act
      fire(review, 'acp-change-toggle', { id: 'branch.js' });
      await until(() => review.diffs.get('branch.js')?.loading === false);
      await el.updateComplete;
      // Assert
      expect(review.compareTo).to.equal('main');
      expect(review.changes.files).to.deep.equal([branchFile]);
      expect(calls.find((c) => c.cmd === 'git_file_at_rev')?.args).to.deep.equal({ rootId: 'r1', rev: 'b1', path: 'branch.js' });
      expect(calls.some((c) => c.cmd === 'git_file_at_head')).to.equal(false);
      expect(listed).to.deep.equal(['/p/branch.js']);
    });

    it('never shows a diff against another baseline, and going back brings the expanded local files back', async () => {
      // Arrange
      const branchFile = /** @type {GitFileStatus} */ ({ ...FILES[0], path: 'branch.js' });
      openChanges();
      const { el, review } = await render();
      fire(review, 'acp-change-toggle', { id: 'a.js' });
      await until(() => review.diffs.get('a.js')?.loading === false);
      // Act
      compareTo('main', null, []);
      await el.updateComplete;
      const whileLoading = { diffs: review.diffs.size, expanded: [...review.expanded] };
      compareTo('main', 'b1', [FILES[0], branchFile]);
      await el.updateComplete;
      fire(review, 'acp-change-toggle', { id: 'branch.js' });
      await until(() => review.diffs.get('branch.js')?.loading === false);
      const asked = calls.filter((c) => c.cmd === 'git_file_at_rev').length;
      compareTo('main', 'b2', [branchFile]);
      await until(() => calls.filter((c) => c.cmd === 'git_file_at_rev').length > asked);
      const movedBase = calls.filter((c) => c.cmd === 'git_file_at_rev').at(-1)?.args.rev;
      $gitCompare.set(NO_COMPARE);
      await el.updateComplete;
      await until(() => review.diffs.get('a.js')?.loading === false);
      // Assert
      expect(whileLoading.diffs, 'the local diff doesn’t stay under the branch').to.equal(0);
      expect(whileLoading.expanded).to.deep.equal([]);
      expect(movedBase).to.equal('b2');
      expect([...review.expanded]).to.deep.equal(['a.js']);
      expect(review.changes.files).to.equal(FILES);
    });

    it('drops a read still running when the comparison starts: its file no longer shows', async () => {
      // Arrange
      /** @type {((text: string) => void)[]} */
      const held = [];
      mockIPC((cmd) => {
        if (cmd === 'git_status') return { version: 1, unchanged: true, status: null };
        if (cmd === 'read_file') return fileBytes('new text');
        if (cmd === 'git_file_at_head') return new Promise((resolve) => held.push(resolve));
        return null;
      });
      openChanges();
      const { el, review } = await render();
      fire(review, 'acp-change-toggle', { id: 'a.js' });
      await until(() => held.length === 1);
      // Act
      compareTo('main', 'b1', [FILES[0]]);
      await el.updateComplete;
      held[0]('old text');
      await new Promise((r) => setTimeout(r, 20));
      await el.updateComplete;
      // Assert
      expect(review.diffs.size).to.equal(0);
    });

    it('closing the tab forgets the local files expanded before the comparison', async () => {
      // Arrange
      openChanges();
      const { el, review } = await render();
      fire(review, 'acp-change-toggle', { id: 'a.js' });
      compareTo('main', 'b1', [FILES[0]]);
      await el.updateComplete;
      // Act
      closeAllTabs();
      await el.updateComplete;
      $gitCompare.set(NO_COMPARE);
      openChanges();
      await el.updateComplete;
      // Assert
      expect([...review.expanded]).to.deep.equal([]);
    });

    it('another project with the tab open and back gives local changes their expanded files back, and none reach that project', async () => {
      // Arrange: tabs are per project; and as the git hook does, the comparison changes first when the project does
      $project.set({ path: '/q', name: 'q', rootId: 'r2' });
      openChanges();
      $project.set({ path: '/p', name: 'p', rootId: 'r1' });
      const stopFollowing = $rootId.listen((rootId) => $gitCompare.set(rootId === 'r1' ? { target: 'main', base: 'b1', changes: { files: [FILES[0]], loaded: true, loading: false, error: null }, refreshError: null } : NO_COMPARE));
      openChanges();
      const { el, review } = await render();
      fire(review, 'acp-change-toggle', { id: 'a.js' });
      compareTo('main', 'b1', [FILES[0]]);
      await el.updateComplete;
      const whileComparing = [...review.expanded];
      // Act
      $project.set({ path: '/q', name: 'q', rootId: 'r2' });
      await el.updateComplete;
      const inOther = [...review.expanded];
      $project.set({ path: '/p', name: 'p', rootId: 'r1' });
      await el.updateComplete;
      $gitCompare.set(NO_COMPARE);
      await el.updateComplete;
      stopFollowing();
      const back = [...review.expanded];
      $project.set({ path: '/q', name: 'q', rootId: 'r2' });
      closeAllTabs();
      // Assert
      expect(whileComparing).to.deep.equal([]);
      expect(inOther).to.deep.equal([]);
      expect(back).to.deep.equal(['a.js']);
    });
  });

  it('in a worktree session, gives the review the worktree as its root and lists the comments on its files', async () => {
    // Arrange
    $project.set({ path: '/p', name: 'p', rootId: 'r1' });
    setWorkspaces([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/s1' })], '/p');
    $openRoots.set({ '/wt/s1': 'r-w' });
    setActiveWorkspace('/p', 'w1');
    const thread = /** @type {never} */ ({ id: 't1', line: 1, comments: [{ id: 'c1', body: 'Why?' }] });
    $comments.set({ '/wt/s1/a.js': [thread], '/p/a.js': [thread] });
    openChanges();
    // Act
    const { review } = await render();
    // Assert
    expect(review.root).to.equal('/wt/s1');
    expect($tabComments.get().map((c) => c.path)).to.deep.equal(['/wt/s1/a.js']);
  });

  it('gives the review the project’s changes, repository, picks and comments, and the project folder as its root', async () => {
    // Arrange
    const { el, review } = await render();
    // Act
    $commitSelection.set(new Set(['a.js']));
    $comments.set({ '/p/a.js': [] });
    const focus = /** @type {never} */ ({ path: '/p/a.js', threadId: 't1' });
    $commentFocus.set(focus);
    await el.updateComplete;
    // Assert
    expect(review.changes).to.equal(CHANGES);
    expect(review.repo).to.equal(REPO);
    expect([...review.selection]).to.deep.equal(['a.js']);
    expect(review.root).to.equal('/p');
    expect(review.comments).to.equal($comments.get());
    expect(review.commentFocus === focus).to.equal(true);
  });

  it('shows the saved diff layout and saves the one the review asks for', async () => {
    // Arrange
    $diffLayout.set('split');
    const { el, review } = await render();
    expect(review.diffLayout).to.equal('split');
    // Act
    fire(review, 'acp-diff-layout', { layout: 'unified' });
    await el.updateComplete;
    // Assert
    expect($diffLayout.get()).to.equal('unified');
    expect(review.diffLayout).to.equal('unified');
  });

  it('reads a renamed file at HEAD under its old name', async () => {
    // Arrange
    const { el, review } = await render();
    $gitChanges.set({ ...CHANGES, files: [{ ...CHANGES.files[0], path: 'new.js', kind: 'renamed', origPath: 'old.js' }] });
    await el.updateComplete;
    // Act
    fire(review, 'acp-change-expand', { id: 'new.js' });
    await until(() => review.diffs.get('new.js')?.loading === false);
    // Assert
    expect(calls.find((c) => c.cmd === 'git_file_at_head')?.args).to.deep.equal({ rootId: 'r1', path: 'old.js' });
  });

  it('turns the review’s events into expanding, collapsing and picking files, and none leaves the view', async () => {
    // Arrange
    const { el, review } = await render();
    /** @type {Event[]} */
    const leaked = [];
    const types = ['acp-change-toggle', 'acp-change-expand', 'acp-changes-collapse', 'acp-commit-pick', 'acp-commit-select'];
    for (const type of types) el.addEventListener(type, (e) => leaked.push(e));
    // Act: a toggle shows the file's diff, read from disk and from HEAD
    fire(review, 'acp-change-toggle', { id: 'a.js' });
    await until(() => review.diffs.get('a.js')?.loading === false);
    // Assert
    expect([...review.expanded]).to.deep.equal(['a.js']);
    expect(review.diffs.get('a.js')).to.deep.include({ content: 'new text', baseline: 'old text' });
    expect(calls.find((c) => c.cmd === 'read_file')?.args).to.deep.equal({ path: '/p/a.js' });
    expect(calls.find((c) => c.cmd === 'git_file_at_head')?.args).to.deep.equal({ rootId: 'r1', path: 'a.js' });
    // Act
    fire(review, 'acp-change-expand', { id: 'b.js' });
    await el.updateComplete;
    // Assert
    expect([...review.expanded].sort()).to.deep.equal(['a.js', 'b.js']);
    // Act
    fire(review, 'acp-changes-collapse');
    fire(review, 'acp-commit-pick', { ids: ['a.js', 'b.js'], picked: true });
    fire(review, 'acp-commit-pick', { ids: ['b.js'], picked: false });
    await el.updateComplete;
    // Assert
    expect(review.expanded.size).to.equal(0);
    expect([...$commitSelection.get()]).to.deep.equal(['a.js']);
    // Act
    fire(review, 'acp-commit-select', { ids: ['b.js'] });
    // Assert
    expect([...$commitSelection.get()]).to.deep.equal(['b.js']);
    expect(leaked).to.deep.equal([]);
  });

  it('shows a file’s diff and scrolls to it on request', async () => {
    // Arrange
    const { el } = await render();
    /** @type {string[]} */
    const scrolled = [];
    const original = AcpChangesReview.prototype.scrollToChange;
    AcpChangesReview.prototype.scrollToChange = async function scrollToChange(id) {
      scrolled.push(id);
    };
    try {
      // Act
      await el.reveal('b.js');
    } finally {
      AcpChangesReview.prototype.scrollToChange = original;
    }
    // Assert
    expect([...(/** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review')).expanded)]).to.deep.equal(['b.js']);
    expect(scrolled).to.deep.equal(['b.js']);
  });

  it('watches the working tree only while the Changes tab is the active one', async () => {
    // Arrange
    const { el } = await render();
    await new Promise((r) => setTimeout(r, 0));
    // Assert
    expect(calls.map((c) => c.cmd), 'another tab is active').to.not.include('git_status');
    // Act
    openChanges();
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    // Assert
    expect(calls.find((c) => c.cmd === 'git_status')?.args).to.deep.include({ rootId: 'r1' });
    expect($gitChanges.get().files, 'the listed files stay').to.equal(FILES);
    // Act: while it watches, a refresh scans again; another tab active, or the view gone, it does not
    calls.length = 0;
    git.refreshChanges();
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    openSettings();
    await new Promise((r) => setTimeout(r, 0));
    calls.length = 0;
    git.refreshChanges();
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(calls.map((c) => c.cmd), 'stopped when another tab became the active one').to.not.include('git_status');
    // Act
    openChanges();
    await until(() => calls.some((c) => c.cmd === 'git_status'));
    el.remove();
    calls.length = 0;
    git.refreshChanges();
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(calls.map((c) => c.cmd), 'stopped when the view went').to.not.include('git_status');
  });
});
