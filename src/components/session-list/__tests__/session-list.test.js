import { expect, fixture, html } from '../../../../test/fixture.js';
import '../session-list.js';

/** @typedef {import('../session-list.js').AcpSessionList} AcpSessionList */
/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../../hooks/sessions/types.js').Subagent} Subagent */

/**
 * @param {string} id
 * @param {Partial<Session>} [fields]
 * @returns {Session}
 */
function session(id, fields = {}) {
  return {
    id,
    projectId: '/home/me/brama',
    title: `Session ${id}`,
    status: 'idle',
    agentId: 'a',
    config: {},
    folder: '/home/me/brama',
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
    ...fields,
  };
}

const SESSIONS = [
  session('a', { lastActivityAt: '2026-01-02T00:00:00.000Z' }),
  session('b', { lastActivityAt: '2026-01-03T00:00:00.000Z' }),
  session('c', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
];

/**
 * @param {string} id
 * @param {Partial<Subagent>} [fields]
 * @returns {Subagent}
 */
const subagent = (id, fields = {}) => ({
  id,
  title: `Task ${id}`,
  description: 'Explore',
  state: 'running',
  stopReason: null,
  cancellable: true,
  announcedAt: '2026-01-01T00:00:00.000Z',
  ...fields,
});

/**
 * @param {Partial<AcpSessionList>} [props]
 */
async function render(props = {}) {
  const el = /** @type {AcpSessionList} */ (
    await fixture(html`<acp-session-list .sessions=${SESSIONS}></acp-session-list>`)
  );
  Object.assign(el, props);
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  const tree = () => /** @type {HTMLElementTagNameMap['tvx-tree-view']} */ (root.querySelector('tvx-tree-view'));
  /** Every visible row's element. */
  const rows = () => /** @type {HTMLElement[]} */ ([...(tree()?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? [])]);
  /** @param {HTMLElement} r */
  const textOf = (r) => r.querySelector('.tree-view__label')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** Every visible row's label. */
  const labels = () => rows().map(textOf);
  /** @param {string} label */
  const rowOf = (label) => {
    const found = rows().find((r) => textOf(r) === label);
    if (!found) throw new Error(`no row ${label}: ${labels().join(' | ')}`);
    return found;
  };
  /** The selected rows' labels. */
  const selected = () => rows().filter((r) => r.getAttribute('aria-selected') === 'true').map(textOf);
  /** @param {string} label */
  const trailing = (label) => /** @type {HTMLElementTagNameMap['acp-session-row-trailing']} */ (rowOf(label).querySelector('acp-session-row-trailing'));
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;
  };
  const menu = () => /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
  return { el, root, tree, rows, labels, rowOf, selected, trailing, settle, menu };
}

/**
 * @param {Element} el
 * @param {string} type
 * @returns {CustomEvent[]}
 */
function record(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

/** @param {Element} row */
const dblclick = (row) => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
/** @param {Element} row @param {string} key @param {KeyboardEventInit} [init] */
const press = (row, key, init = {}) => row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init }));
/** @param {Element} row */
const rightClick = (row) =>
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2, clientX: 5, clientY: 5 }));

describe('acp-session-list', () => {
  it('groups the chats in Unread and Read folders with their counts, pinned first, then by activity; a folder with none is not shown', async () => {
    // Act
    const { el, labels, trailing, tree } = await render({ unread: ['a'], pinned: ['c'], waiting: ['b'] });
    // Assert
    expect(tree().getAttribute('aria-label')).to.equal('Chats');
    expect(labels()).to.deep.equal(['Unread 1 session', 'Session a', 'Read 2 sessions', 'Session c', 'Session b']);
    expect([trailing('Session a').unread, trailing('Session c').pinned, trailing('Session b').waiting]).to.deep.equal([true, true, true]);
    expect(el.shadowRoot?.querySelector('[title]'), 'tooltips, not titles').to.equal(null);

    // Act: all read
    el.unread = [];
    await el.updateComplete;
    await tree().updateComplete;
    // Assert
    expect(labels()).to.deep.equal(['Read 3 sessions', 'Session c', 'Session b', 'Session a']);
  });

  it('draws an unread chat with a dot, a read one with its agent’s icon', async () => {
    // Act
    const { rowOf } = await render({ unread: ['a'] });
    // Assert
    expect(rowOf('Session a').querySelector('[data-unread-dot]')).to.not.equal(null);
    expect(rowOf('Session a').querySelector('acp-agent-icon')).to.equal(null);
    expect(rowOf('Session b').querySelector('[data-unread-dot]')).to.equal(null);
    expect(rowOf('Session b').querySelector('acp-agent-icon')).to.not.equal(null);
  });

  it('names a chat’s row for assistive tech: title, agent, unread, pinned, worktree, age and status', async () => {
    // Arrange
    const now = Date.parse('2026-01-01T02:00:00.000Z');
    const sessions = [session('x', { title: 'Fix', agentName: 'Claude', branch: 'f/x', status: 'working' })];
    // Act
    const { rowOf } = await render({ sessions, unread: ['x'], pinned: ['x'], now });
    // Assert
    expect(rowOf('Fix').querySelector('.tree-view__label [aria-label]')?.getAttribute('aria-label')).to.equal(
      'Fix, Claude, unread, pinned, worktree on f/x, 2 hours ago, Agent is working',
    );
  });

  it('selects a chat on one click, opens it on a double-click or Enter', async () => {
    // Arrange
    const { el, rowOf, selected, tree } = await render({ activeSessionId: 'b' });
    await tree().updateComplete;
    const opened = record(el, 'acp-session-select');
    // Assert: the open chat starts selected
    expect(selected()).to.deep.equal(['Session b']);
    // Act
    rowOf('Session a').click();
    await tree().updateComplete;
    // Assert
    expect(selected()).to.deep.equal(['Session a']);
    expect(opened, 'a click only selects').to.have.length(0);
    // Act
    dblclick(rowOf('Session a'));
    press(rowOf('Session c'), 'Enter');
    // Assert
    expect(opened.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a' }, { sessionId: 'c' }]);

    // Act: a chat opened from elsewhere
    el.activeSessionId = 'c';
    await el.updateComplete;
    await tree().updateComplete;
    // Assert
    expect(selected()).to.deep.equal(['Session c']);
  });

  it('keeps the open chat or subagent highlighted while another row is selected, and says it is open', async () => {
    // Arrange
    const { el, rowOf, tree } = await render({ activeSessionId: 'b', subagents: { b: [subagent('x')] } });
    await tree().updateComplete;
    const marked = (/** @type {string} */ label) => rowOf(label).querySelector('[data-open-mark]') !== null;
    // Assert: selected too, the selection's own highlight is enough
    expect(marked('Session b')).to.equal(false);
    // Act
    rowOf('Session a').click();
    await tree().updateComplete;
    // Assert
    expect(marked('Session b')).to.equal(true);
    expect(marked('Session a')).to.equal(false);
    expect(rowOf('Session b').querySelector('.tree-view__label [aria-label]')?.getAttribute('aria-label')).to.contain('Session b, a, open');
    expect(rowOf('Session a').querySelector('.tree-view__label [aria-label]')?.getAttribute('aria-label')).to.not.contain('open');
    // Act: its subagent's chat is the one shown
    el.activeSubagentId = 'x';
    await el.updateComplete;
    rowOf('Session a').click();
    await tree().updateComplete;
    // Assert
    expect(marked('Explore · Task x')).to.equal(true);
    expect(marked('Session b')).to.equal(false);
  });

  it('opens and closes a folder with a click or Enter, without selecting it or opening anything', async () => {
    // Arrange
    const { el, labels, rowOf, selected, tree } = await render({ activeSessionId: 'a', unread: ['a'] });
    await tree().updateComplete;
    const opened = record(el, 'acp-session-select');
    // Act
    rowOf('Read 2 sessions').click();
    await el.updateComplete;
    await tree().updateComplete;
    // Assert
    expect(labels()).to.deep.equal(['Unread 1 session', 'Session a', 'Read 2 sessions']);
    expect(rowOf('Read 2 sessions').getAttribute('aria-expanded')).to.equal('false');
    expect(selected(), 'a folder takes no selection').to.deep.equal(['Session a']);

    // Act
    press(rowOf('Read 2 sessions'), ' ');
    await tree().updateComplete;
    // Assert
    expect(selected(), 'nor with Space').to.deep.equal(['Session a']);

    // Act: stays closed as chats change
    el.unread = [];
    await el.updateComplete;
    await tree().updateComplete;
    // Assert
    expect(labels()).to.deep.equal(['Read 3 sessions']);

    // Act
    press(rowOf('Read 3 sessions'), 'Enter');
    await el.updateComplete;
    await tree().updateComplete;
    // Assert
    expect(labels()).to.have.length(4);
    dblclick(rowOf('Read 3 sessions'));
    expect(opened).to.have.length(0);
  });

  it('opens the Unread folder again when it comes back after emptying', async () => {
    // Arrange
    const { el, labels, tree } = await render({ unread: ['a'] });
    const update = async () => {
      await el.updateComplete;
      await tree().updateComplete;
    };
    await update();
    // Act
    el.unread = [];
    await update();
    el.unread = ['b'];
    await update();
    // Assert
    expect(labels().slice(0, 2)).to.deep.equal(['Unread 1 session', 'Session b']);
  });

  it('says there are no chats yet, or shows skeleton rows while they load, until it has chats', async () => {
    const cases = [
      // [sessions, loading, empty text, skeleton rows, rows]
      [[], false, 'No chats yet', 0, 0],
      [[], true, null, 3, 0],
      [SESSIONS, true, null, 0, 4],
    ];
    for (const [sessions, loading, empty, skeletons, count] of cases) {
      // Act
      const { root, tree, rows } = await render({ sessions: /** @type {Session[]} */ (sessions), loading: /** @type {boolean} */ (loading) });
      await tree()?.updateComplete;
      // Assert
      const why = `loading ${loading}, ${/** @type {Session[]} */ (sessions).length} chats`;
      expect(root.querySelector('.acp-session-list__empty')?.textContent?.trim() ?? null, why).to.equal(empty);
      expect(root.querySelectorAll('.acp-session-list__loading[aria-label="Loading chats"] .acp-session-list__skeleton-row'), why).to.have.length(/** @type {number} */ (skeletons));
      expect(rows(), why).to.have.length(/** @type {number} */ (count));
    }
  });

  describe('session menu', () => {
    it('opens the one shared menu under a row’s menu button for that session, marks the row, and passes its picks on', async () => {
      // Arrange
      const { el, trailing, settle, menu } = await render();
      const selects = record(el, 'acp-session-select');
      const more = /** @type {HTMLElement} */ (trailing('Session a').shadowRoot?.querySelector('.acp-session-row-trailing__more'));
      // Act
      more.click();
      await settle();
      // Assert
      const md = /** @type {HTMLElementTagNameMap['md-menu']} */ (menu().menu);
      expect([md.open, md.anchorElement]).to.deep.equal([true, more]);
      expect(menu().sessionTitle).to.equal('Session a');
      expect(trailing('Session a').menuOpen, 'the row keeps its button').to.equal(true);
      expect(selects).to.have.length(0);
      for (const [value, type] of [['reveal', 'acp-session-reveal'], ['open-terminal', 'acp-session-open-terminal'], ['delete', 'acp-session-delete']]) {
        // Act
        const heard = record(el, type);
        menu().dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value }, bubbles: true, composed: true }));
        // Assert
        expect(heard.map((e) => e.detail), value).to.deep.equal([{ sessionId: 'a' }]);
      }
    });

    it('opens on a right-click, ContextMenu or Shift+F10, offering Reset to agent title for a session the user renamed after the agent named it', async () => {
      // Arrange
      const sessions = [session('u', { titleSource: 'user', agentTitle: 'Agent’s' }), session('p')];
      const { el, rowOf, settle, menu } = await render({ sessions });
      const resets = record(el, 'acp-session-reset-title');
      const cases = /** @type {[string, boolean, (row: HTMLElement) => void][]} */ ([
        ['Session u', true, rightClick],
        ['Session p', false, rightClick],
        ['Session u', true, (r) => press(r, 'ContextMenu')],
        ['Session p', false, (r) => press(r, 'F10', { shiftKey: true })],
      ]);
      for (const [title, resettable, open] of cases) {
        // Act
        open(rowOf(title));
        await settle();
        // Assert
        expect(menu().menu?.open, title).to.equal(true);
        expect(menu().sessionTitle).to.equal(title);
        expect(menu().resettable, title).to.equal(resettable);
      }
      // Act
      rightClick(rowOf('Session u'));
      await settle();
      menu().dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'reset-title' }, bubbles: true, composed: true }));
      // Assert
      expect(resets.map((e) => e.detail)).to.deep.equal([{ sessionId: 'u' }]);
    });

    it('offers Mark as read on an unread row and Mark as unread on a read one, but only Mark as read on the shown session, and passes the pick on', async () => {
      // Arrange
      const { el, rowOf, settle, menu, tree } = await render({ unread: ['a', 'b'], activeSessionId: 'b' });
      await tree().updateComplete;
      const marks = record(el, 'acp-session-mark-read');
      const cases = [
        // [title, mark, why]
        ['Session a', 'read', 'unread'],
        ['Session c', 'unread', 'read'],
        ['Session b', 'read', 'shown and unread (not seen)'],
      ];
      for (const [title, mark, why] of cases) {
        // Act
        rightClick(rowOf(title));
        await settle();
        // Assert
        expect(menu().mark, why).to.equal(mark);
      }
      // Arrange: the shown session is read
      el.unread = ['a'];
      await el.updateComplete;
      await tree().updateComplete;
      // Act
      rightClick(rowOf('Session b'));
      await settle();
      // Assert
      expect(menu().mark, 'shown and read').to.equal('');
      // Act
      for (const value of ['mark-read', 'mark-unread']) {
        menu().dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value }, bubbles: true, composed: true }));
      }
      // Assert
      expect(marks.map((e) => e.detail)).to.deep.equal([
        { sessionId: 'b', read: true },
        { sessionId: 'b', read: false },
      ]);
    });

    it('offers Pin or Unpin and passes the pick on, as the row’s pin button does', async () => {
      // Arrange
      const { el, rowOf, trailing, settle, menu, tree } = await render({ pinned: ['a'] });
      await tree().updateComplete;
      const pins = record(el, 'acp-session-pin');
      // Act + Assert
      rightClick(rowOf('Session a'));
      await settle();
      expect(menu().pin).to.equal('unpin');
      menu().dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'unpin' }, bubbles: true, composed: true }));
      rightClick(rowOf('Session b'));
      await settle();
      expect(menu().pin).to.equal('pin');
      menu().dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'pin' }, bubbles: true, composed: true }));
      /** @type {HTMLElement} */ (trailing('Session c').shadowRoot?.querySelector('.acp-session-row-trailing__pin')).click();
      // Assert
      expect(pins.map((e) => e.detail)).to.deep.equal([
        { sessionId: 'a', pinned: false },
        { sessionId: 'b', pinned: true },
        { sessionId: 'c', pinned: true },
      ]);
    });
  });

  it('renames in place on F2 or the menu’s Rename, and passes a changed title on; Escape keeps it', async () => {
    // Arrange
    const { el, rowOf, settle, menu, tree } = await render();
    await tree().updateComplete;
    const renames = record(el, 'acp-session-rename');
    const input = () => /** @type {HTMLInputElement | null} */ (tree().shadowRoot?.querySelector('.tree-view__label-input') ?? null);
    /** @param {string} key */
    const keyInField = (key) => input()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));
    // Act
    press(rowOf('Session a'), 'F2');
    await settle();
    await tree().updateComplete;
    // Assert
    expect(input()?.value).to.equal('Session a');
    // Act
    keyInField('Escape');
    await settle();
    await tree().updateComplete;
    // Assert
    expect(input(), 'left').to.equal(null);
    expect(renames).to.have.length(0);
    // Act
    rightClick(rowOf('Session b'));
    await settle();
    menu().dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'rename' }, bubbles: true, composed: true }));
    await settle();
    await tree().updateComplete;
    /** @type {HTMLInputElement} */ (input()).value = '  New title ';
    keyInField('Enter');
    await settle();
    // Assert
    expect(renames.map((e) => e.detail)).to.deep.equal([{ sessionId: 'b', title: 'New title' }]);
  });

  it('shows the newest read chats, five more with each Show more; every unread chat shows', async () => {
    // Arrange
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${i}`, { lastActivityAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const { el, labels, rowOf, tree } = await render({ sessions, unread: ['s0'] });
    await tree().updateComplete;
    const chats = () => labels().filter((l) => l.startsWith('Session'));
    const update = async () => {
      await el.updateComplete;
      await tree().updateComplete;
    };
    // Assert
    expect(labels()[0]).to.equal('Unread 1 session');
    expect(labels()[2]).to.equal('Read 11 sessions');
    expect(chats()).to.deep.equal(['Session s0', 'Session s11', 'Session s10', 'Session s9', 'Session s8', 'Session s7']);
    expect(labels().at(-1)).to.equal('Show more…');
    expect(rowOf('Show more…').getAttribute('aria-level'), 'Read’s last child').to.equal('2');
    // Act
    rowOf('Show more…').click();
    await update();
    // Assert
    expect(chats()).to.have.length(11);
    expect(rowOf('Show more…').getAttribute('aria-selected'), 'not selected').to.equal('false');
    expect(tree().navigation.getFocused(), 'on the first new row').to.equal('s6');
    // Act
    press(rowOf('Show more…'), 'Enter');
    await update();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Assert
    expect(chats()).to.have.length(12);
    expect(tree().navigation.getFocused(), 'Show more gone').to.equal('s1');
    expect(labels()).to.not.include('Show more…');
  });

  it('shows the read chats down to the open one', async () => {
    // Arrange
    const sessions = Array.from({ length: 8 }, (_, i) => session(`s${i}`, { lastActivityAt: `2026-01-0${8 - i}T00:00:00.000Z` }));
    // Act
    const { labels, tree } = await render({ sessions, activeSessionId: 's6' });
    await tree().updateComplete;
    // Assert
    expect(labels().filter((l) => l.startsWith('Session'))).to.have.length(7);
  });

  describe('subagents', () => {
    it('shows them under their chat with kind, title, status and age, as they appear', async () => {
      // Act
      const { rows, labels, tree, el } = await render({
        now: Date.parse('2026-01-01T00:03:00.000Z'),
        subagents: {
          a: [subagent('r'), subagent('w', { state: 'requires_action' }), subagent('d', { state: 'idle', stopReason: 'end_turn', description: null })],
        },
      });
      await el.updateComplete;
      await tree().updateComplete;
      // Assert
      expect(labels()).to.deep.equal(['Read 3 sessions', 'Session b', 'Session a', 'Explore · Task r', 'Explore · Task w', 'Task d', 'Session c']);
      const row = (/** @type {number} */ i) => rows()[i];
      expect(row(3).getAttribute('aria-level')).to.equal('3');
      expect(row(3).querySelector('[data-status]')?.getAttribute('aria-label')).to.equal('Working');
      expect(row(4).querySelector('[data-status]')?.getAttribute('aria-label')).to.equal('Waiting for you');
      expect(row(4).querySelector('.tree-view__trailing')?.textContent?.trim()).to.equal('waiting');
      expect(row(5).querySelector('[data-status]')?.getAttribute('aria-label')).to.equal('Done');
    });

    it('selects a subagent on a click, opens its chat on a double-click or Enter, and follows the open one', async () => {
      // Arrange
      const subagents = { a: [subagent('x'), subagent('y')] };
      const { el, rowOf, selected, tree } = await render({ subagents, activeSessionId: 'a' });
      await el.updateComplete;
      await tree().updateComplete;
      const opened = record(el, 'acp-subagent-open');
      // Act
      rowOf('Explore · Task x').click();
      await tree().updateComplete;
      // Assert
      expect(opened).to.have.length(0);
      expect(selected()).to.deep.equal(['Explore · Task x']);
      // Act
      dblclick(rowOf('Explore · Task x'));
      press(rowOf('Explore · Task y'), 'Enter');
      // Assert
      expect(opened.map((e) => e.detail)).to.deep.equal([
        { sessionId: 'a', subagentId: 'x' },
        { sessionId: 'a', subagentId: 'y' },
      ]);
      // Act
      el.activeSubagentId = 'y';
      await el.updateComplete;
      await tree().updateComplete;
      // Assert
      expect(selected()).to.deep.equal(['Explore · Task y']);
    });

    it('closes and opens them with the chevron or the arrows, and keeps them closed once closed, as more appear', async () => {
      // Arrange
      const { el, labels, rowOf, trailing, tree } = await render({ subagents: { a: [subagent('x')] } });
      await el.updateComplete;
      await tree().updateComplete;
      const shown = () => labels().includes('Explore · Task x');
      const update = async () => {
        await el.updateComplete;
        await tree().updateComplete;
      };
      // Assert
      expect(shown()).to.equal(true);
      expect(trailing('Session a').expanded).to.equal(true);
      expect(trailing('Session b').subagents).to.equal(0);
      // Act
      /** @type {HTMLElement} */ (trailing('Session a').shadowRoot?.querySelector('.acp-session-row-trailing__toggle')).click();
      await update();
      // Assert
      expect(shown(), 'chevron closes').to.equal(false);
      // Act
      press(rowOf('Session a'), 'ArrowRight');
      await update();
      // Assert
      expect(shown(), 'Right opens').to.equal(true);
      // Act
      press(rowOf('Session a'), 'ArrowLeft');
      await update();
      // Assert
      expect(shown(), 'Left closes').to.equal(false);
      expect(trailing('Session a').expanded).to.equal(false);
      // Act
      el.subagents = { a: [subagent('x'), subagent('y')] };
      await update();
      // Assert
      expect(trailing('Session a').subagents).to.equal(2);
      expect(labels()).to.not.include('Explore · Task y');
    });

    it('does not toggle a chat with subagents on a click or Enter', async () => {
      // Arrange
      const { el, labels, rowOf, tree } = await render({ subagents: { a: [subagent('x')] } });
      await el.updateComplete;
      await tree().updateComplete;
      // Act
      rowOf('Session a').click();
      press(rowOf('Session a'), 'Enter');
      await el.updateComplete;
      await tree().updateComplete;
      // Assert
      expect(labels()).to.include('Explore · Task x');
    });
  });
});
