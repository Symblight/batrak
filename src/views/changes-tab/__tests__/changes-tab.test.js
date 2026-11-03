import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { git } from '../../../hooks/git/git.js';
import { $commentFocus, $comments } from '../../../stores/comments/comments.js';
import { closeAllTabs, openChanges, openSettings } from '../../../stores/editor/editor.js';
import { $commitSelection, $gitChanges, $gitRepo } from '../../../stores/git/git.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
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
      if (cmd === 'read_file') return 'new text';
      if (cmd === 'git_file_at_head') return 'old text';
      return null;
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r1' });
    $gitChanges.set(CHANGES);
    $gitRepo.set(REPO);
    // The Changes tab is open, but another tab is active: nothing watches the working tree yet.
    openChanges();
    openSettings();
  });

  afterEach(() => {
    closeAllTabs();
    $commitSelection.set(new Set());
    $comments.set({});
    $commentFocus.set(null);
    $workspace.set(null);
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
