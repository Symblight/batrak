import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $comments } from '../../../stores/comments/comments.js';
import { activateTab, closeAllTabs, openTab } from '../../../stores/editor/editor.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import { sessionChangesTabId } from '../../../stores/tab-ids/tab-ids.js';
import '../session-changes-tab.js';

/** @typedef {import('../session-changes-tab.js').AcpSessionChangesTab} AcpSessionChangesTab */

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
const session = (id) => /** @type {never} */ ({ id, title: id, status: 'idle', folder: `/wt/${id}`, branch: `brama/${id}`, baseCommit: `base-${id}`, mode: 'worktree' });

describe('acp-session-changes-tab', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      if (cmd === 'session_changes') return FILES;
      if (cmd === 'read_file') return 'new text';
      if (cmd === 'session_file_at_base') return 'old text';
      if (cmd === 'session_apply_locally') return { outcome: 'clean' };
      return null;
    });
    $sessions.set([session('s1'), session('s2')]);
    openTab(sessionChangesTabId('s1'));
    openTab(sessionChangesTabId('s2'));
    activateTab(sessionChangesTabId('s1'));
  });

  afterEach(() => {
    closeAllTabs();
    $sessions.set([]);
    $comments.set({});
    clearMocks();
  });

  /**
   * @param {string} sessionId
   * @returns {Promise<{ el: AcpSessionChangesTab, review: HTMLElementTagNameMap['acp-changes-review'] | null }>}
   */
  async function render(sessionId) {
    const el = /** @type {AcpSessionChangesTab} */ (await fixture(html`<acp-session-changes-tab .sessionId=${sessionId}></acp-session-changes-tab>`));
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

  it('lists the session’s changes since its base when its tab is the active one, and only then', async () => {
    // Arrange: s2's tab is not the active one
    const other = await render('s2');
    await new Promise((r) => setTimeout(r, 0));
    // Assert
    expect(other.review, 'not active').to.equal(null);
    expect(calls.filter((c) => c.cmd === 'session_changes').map((c) => c.args.sessionId), 'only the active tab’s session is listed').to.deep.equal([]);
    // Act
    const { el } = await render('s1');
    await until(() => el.querySelector('acp-changes-review')?.changes.loaded === true);
    const review = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review'));
    // Assert
    expect(review.changes.files).to.deep.equal(FILES);
    expect([review.root, review.base, review.branch]).to.deep.equal(['/wt/s1', 'base-s1', 'brama/s1']);
    expect(calls.filter((c) => c.cmd === 'session_changes').map((c) => c.args.sessionId)).to.deep.equal(['s1']);
    // Act: the other tab becomes the active one
    activateTab(sessionChangesTabId('s2'));
    await until(() => other.el.querySelector('acp-changes-review') !== null);
    await el.updateComplete;
    // Assert
    expect(el.querySelector('acp-changes-review'), 'the first lets go').to.equal(null);
    // Act: a view whose session is set after it came up
    activateTab(sessionChangesTabId('s1'));
    const late = await render(/** @type {never} */ (null));
    late.el.sessionId = 's1';
    await until(() => late.el.querySelector('acp-changes-review') !== null);
    // Assert
    expect(late.el.querySelector('acp-changes-review')?.base).to.equal('base-s1');
  });

  it('turns the review’s events into expanding files and the session’s Apply and Check out, and none leaves the view', async () => {
    // Arrange
    const { el } = await render('s1');
    await until(() => el.querySelector('acp-changes-review')?.changes.loaded === true);
    const review = /** @type {HTMLElementTagNameMap['acp-changes-review']} */ (el.querySelector('acp-changes-review'));
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-change-toggle', 'acp-change-expand', 'acp-changes-collapse', 'acp-session-apply', 'acp-session-check-out']) el.addEventListener(type, (e) => leaked.push(e));
    // Act
    fire(review, 'acp-change-toggle', { id: 'a.js' });
    await until(() => review.diffs.get('a.js')?.loading === false);
    // Assert
    expect([...review.expanded]).to.deep.equal(['a.js']);
    expect(review.diffs.get('a.js')).to.deep.include({ content: 'new text', baseline: 'old text' });
    expect(calls.find((c) => c.cmd === 'read_file')?.args).to.deep.equal({ path: '/wt/s1/a.js' });
    expect(calls.find((c) => c.cmd === 'session_file_at_base')?.args).to.deep.equal({ sessionId: 's1', path: 'a.js' });
    // Act
    fire(review, 'acp-changes-collapse');
    fire(review, 'acp-session-apply');
    fire(review, 'acp-session-check-out');
    await until(() => calls.some((c) => c.cmd === 'session_check_out_branch'));
    // Assert
    expect(review.expanded.size).to.equal(0);
    expect(calls.find((c) => c.cmd === 'session_apply_locally')?.args).to.deep.equal({ sessionId: 's1' });
    expect(calls.find((c) => c.cmd === 'session_check_out_branch')?.args).to.deep.equal({ sessionId: 's1' });
    expect(leaked).to.deep.equal([]);
  });
});
