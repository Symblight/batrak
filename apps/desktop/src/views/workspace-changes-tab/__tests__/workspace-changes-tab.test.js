import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fileBytes, fixture, html } from '../../../../test/fixture.js';
import { $commentFocus, $comments } from '../../../stores/comments/comments.js';
import { activateTab, closeAllTabs, openTab } from '../../../stores/editor/editor.js';
import { $diffLayout } from '../../../stores/git/git.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import { $workspaces } from '../../../stores/workspaces/workspaces.js';
import { workspaceChangesTabId } from '../../../stores/tab-ids/tab-ids.js';
import '../workspace-changes-tab.js';

/** @typedef {import('../workspace-changes-tab.js').AcpWorkspaceChangesTab} AcpWorkspaceChangesTab */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const FILES = [{ path: 'a.js', kind: 'modified', staged: false, unstaged: true, origPath: null, added: 1, removed: 0 }];

/** @param {string} id */
const workspace = (id) => /** @type {never} */ ({ id, name: id, folder: `/wt/${id}`, branch: `batrak/${id}`, baseCommit: `base-${id}` });

/**
 * @param {string} id
 * @param {string} workspaceId
 */
const chat = (id, workspaceId) => /** @type {never} */ ({ id, title: id, status: 'idle', workspaceId, folder: `/wt/${workspaceId}` });

describe('acp-workspace-changes-tab', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      if (cmd === 'workspace_changes') return FILES;
      if (cmd === 'read_file') return fileBytes('new text');
      if (cmd === 'workspace_file_at_base') return 'old text';
      if (cmd === 'workspace_apply_locally') return { outcome: 'clean' };
      return null;
    });
    $workspaces.set([workspace('w1'), workspace('w2')]);
    $sessions.set([chat('a1', 'w1'), chat('a2', 'w1'), chat('b1', 'w2')]);
    openTab(workspaceChangesTabId('w1'));
    openTab(workspaceChangesTabId('w2'));
    activateTab(workspaceChangesTabId('w1'));
  });

  afterEach(() => {
    closeAllTabs();
    $sessions.set([]);
    $workspaces.set([]);
    $comments.set({});
    $commentFocus.set(null);
    $diffLayout.set('unified');
    clearMocks();
  });

  it('shows the saved diff layout and saves the one the review asks for', async () => {
    // Arrange
    $diffLayout.set('split');
    const el = /** @type {AcpWorkspaceChangesTab} */ (await fixture(html`<acp-workspace-changes-tab .workspaceId=${'w1'}></acp-workspace-changes-tab>`));
    await until(() => el.querySelector('acp-changes-review') !== null);
    const review = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review'));
    expect(review.diffLayout).to.equal('split');
    // Act
    review.dispatchEvent(new CustomEvent('acp-diff-layout', { detail: { layout: 'unified' }, bubbles: true, composed: true }));
    await el.updateComplete;
    // Assert
    expect($diffLayout.get()).to.equal('unified');
    expect(review.diffLayout).to.equal('unified');
  });

  /**
   * @param {string} workspaceId
   * @returns {Promise<{ el: AcpWorkspaceChangesTab, review: HTMLElementTagNameMap['acp-changes-review'] | null }>}
   */
  async function render(workspaceId) {
    const el = /** @type {AcpWorkspaceChangesTab} */ (await fixture(html`<acp-workspace-changes-tab .workspaceId=${workspaceId}></acp-workspace-changes-tab>`));
    return { el, review: el.querySelector('acp-changes-review') };
  }

  /**
   * @param {Element} from
   * @param {string} type
   * @param {object} [detail]
   */
  function fire(from, type, detail) {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('lists the workspace’s changes since its base when its tab is the active one, and only then', async () => {
    // Arrange: w2's tab is not the active one
    const other = await render('w2');
    await new Promise((r) => setTimeout(r, 0));
    // Assert
    expect(other.review, 'not active').to.equal(null);
    expect(calls.filter((c) => c.cmd === 'workspace_changes').map((c) => c.args.id), 'only the active tab’s workspace is listed').to.deep.equal([]);
    // Act
    const { el } = await render('w1');
    await until(() => el.querySelector('acp-changes-review')?.changes.loaded === true);
    const review = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review'));
    // Assert
    expect(review.changes.files).to.deep.equal(FILES);
    const focus = /** @type {never} */ ({ path: '/wt/w1/a.js', threadId: 't1' });
    $comments.set({ '/wt/w1/a.js': [] });
    $commentFocus.set(focus);
    await el.updateComplete;
    expect([review.comments === $comments.get(), review.commentFocus === focus], 'comments and the one to reveal').to.deep.equal([true, true]);
    expect([review.root, review.base, review.branch]).to.deep.equal(['/wt/w1', 'base-w1', 'batrak/w1']);
    expect(calls.filter((c) => c.cmd === 'workspace_changes').map((c) => c.args.id)).to.deep.equal(['w1']);
    // Act: the other tab becomes the active one
    activateTab(workspaceChangesTabId('w2'));
    await until(() => other.el.querySelector('acp-changes-review') !== null);
    await el.updateComplete;
    // Assert
    expect(el.querySelector('acp-changes-review'), 'the first lets go').to.equal(null);
    // Act: a view whose workspace is set after it came up
    activateTab(workspaceChangesTabId('w1'));
    const late = await render(/** @type {never} */ (null));
    late.el.workspaceId = 'w1';
    await until(() => late.el.querySelector('acp-changes-review') !== null);
    // Assert
    expect(late.el.querySelector('acp-changes-review')?.base).to.equal('base-w1');
  });

  it('lists again when a turn of any of its chats ends, not for another workspace’s, and no more once the tab is gone', async () => {
    // Arrange
    const { el } = await render('w1');
    await until(() => el.querySelector('acp-changes-review')?.changes.loaded === true);
    const listed = () => calls.filter((c) => c.cmd === 'workspace_changes').length;
    const turn = (/** @type {string} */ id, /** @type {'working' | 'idle'} */ status) =>
      $sessions.set($sessions.get().map((s) => (s.id === id ? /** @type {never} */ ({ ...s, status }) : s)));
    // Act: another workspace's chat's turn
    turn('b1', 'working');
    turn('b1', 'idle');
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(listed(), 'another workspace’s turn').to.equal(1);
    // Act: one of its chats ends a turn while the other still runs one, then that one ends
    turn('a1', 'working');
    turn('a2', 'working');
    turn('a1', 'idle');
    await until(() => listed() === 2);
    turn('a2', 'idle');
    await until(() => listed() === 3);
    // Act: the tab goes
    el.remove();
    turn('a1', 'working');
    turn('a1', 'idle');
    await new Promise((r) => setTimeout(r, 50));
    // Assert
    expect(listed(), 'a removed tab lists nothing').to.equal(3);
  });

  it('turns the review’s events into expanding files and the workspace’s Apply and Check out, and none leaves the view', async () => {
    // Arrange
    const { el } = await render('w1');
    await until(() => el.querySelector('acp-changes-review')?.changes.loaded === true);
    const review = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review'));
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-change-toggle', 'acp-change-expand', 'acp-changes-collapse', 'acp-changes-apply', 'acp-changes-check-out']) el.addEventListener(type, (e) => leaked.push(e));
    // Act
    fire(review, 'acp-change-toggle', { id: 'a.js' });
    await until(() => review.diffs.get('a.js')?.loading === false);
    // Assert
    expect([...review.expanded]).to.deep.equal(['a.js']);
    expect(review.diffs.get('a.js')).to.deep.include({ content: 'new text', baseline: 'old text' });
    expect(calls.find((c) => c.cmd === 'read_file')?.args).to.deep.equal({ path: '/wt/w1/a.js' });
    expect(calls.find((c) => c.cmd === 'workspace_file_at_base')?.args).to.deep.equal({ id: 'w1', path: 'a.js' });
    // Act
    fire(review, 'acp-changes-collapse');
    fire(review, 'acp-changes-apply');
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (el.querySelector('acp-confirm-dialog'));
    /** @type {string[]} */
    const asked = [];
    let answer = false;
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return answer;
    };
    fire(review, 'acp-changes-check-out');
    await until(() => asked.length === 1);
    await new Promise((r) => setTimeout(r));
    const refused = calls.filter((c) => c.cmd === 'workspace_check_out_branch').length;
    answer = true;
    fire(review, 'acp-changes-check-out');
    await until(() => calls.some((c) => c.cmd === 'workspace_check_out_branch'));
    // Assert
    expect(review.expanded.size).to.equal(0);
    expect(calls.find((c) => c.cmd === 'workspace_apply_locally')?.args).to.deep.equal({ id: 'w1' });
    expect(refused, 'nothing before a yes').to.equal(0);
    expect(asked[0]).to.match(/^Check out .*\?$/);
    expect(calls.find((c) => c.cmd === 'workspace_check_out_branch')?.args).to.deep.equal({ id: 'w1' });
    expect(leaked).to.deep.equal([]);
  });
});
