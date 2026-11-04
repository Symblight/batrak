import { expect, fixture, html } from '../../../../test/fixture.js';
import '../session-list.js';

/** @typedef {import('../session-list.js').AcpSessionList} AcpSessionList */
/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */

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
 * @param {Partial<AcpSessionList>} [props]
 * @returns {Promise<{ el: AcpSessionList, root: ShadowRoot }>}
 */
async function render(props = {}) {
  const el = /** @type {AcpSessionList} */ (
    await fixture(html`<acp-session-list .sessions=${SESSIONS}></acp-session-list>`)
  );
  Object.assign(el, props);
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
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

/**
 * The session row element whose session has `title`.
 * @param {ShadowRoot} root
 * @param {string} title
 */
function row(root, title) {
  const found = [...root.querySelectorAll('acp-session-row')].find((r) => r.session?.title === title);
  if (!found) throw new Error(`no row for ${title}`);
  return found;
}

/** @param {ShadowRoot} root */
function titles(root) {
  return [...root.querySelectorAll('acp-session-row')].map((r) => r.session?.title);
}

/** @param {AcpSessionList} el */
async function settle(el) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
}

describe('acp-session-list', () => {
  it('lists the chats, pinned first, then by activity, and hands each row its state', async () => {
    // Arrange
    const now = Date.parse('2026-10-23T13:00:00.000Z');
    // Act
    const { root } = await render({ pinned: ['c'], unread: ['b'], waiting: ['a'], activeSessionId: 'b', now });
    // Assert
    expect(titles(root)).to.deep.equal(['Session c', 'Session b', 'Session a']);
    const state = (/** @type {string} */ id) => {
      const r = row(root, `Session ${id}`);
      return [r.selected, r.pinned, r.unread, r.waiting, r.now];
    };
    expect(state('c'), 'pinned').to.deep.equal([false, true, false, false, now]);
    expect(state('b'), 'selected, unread').to.deep.equal([true, false, true, false, now]);
    expect(state('a'), 'waiting for a permission').to.deep.equal([false, false, false, true, now]);
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
  });

  it('passes a row’s select on', async () => {
    // Arrange
    const { el, root } = await render();
    const selects = record(el, 'acp-session-select');
    // Act
    row(root, 'Session a').shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    // Assert
    expect(selects.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a' }]);
  });

  it('says there are no chats yet, or shows skeleton rows while they load, until it has chats', async () => {
    const cases = [
      // [sessions, loading, empty text, skeleton rows, rows]
      [[], false, 'No chats yet', 0, 0],
      [[], true, null, 3, 0],
      [SESSIONS, true, null, 0, 3],
    ];
    for (const [sessions, loading, empty, skeletons, rows] of cases) {
      // Act
      const { root } = await render({ sessions: /** @type {Session[]} */ (sessions), loading: /** @type {boolean} */ (loading) });
      // Assert
      const why = `loading ${loading}, ${/** @type {Session[]} */ (sessions).length} chats`;
      expect(root.querySelector('.acp-session-list__empty')?.textContent?.trim() ?? null, why).to.equal(empty);
      expect(root.querySelectorAll('.acp-session-list__loading[aria-label="Loading chats"] .acp-session-list__skeleton-row'), why).to.have.length(/** @type {number} */ (skeletons));
      expect(titles(root), why).to.have.length(/** @type {number} */ (rows));
    }
  });

  describe('session menu', () => {
    it('opens the one shared menu under a row’s menu button for that session, marks the row, and passes its picks on', async () => {
      const { el, root } = await render();
      const selects = record(el, 'acp-session-select');
      const target = row(root, 'Session a');
      const inner = /** @type {ShadowRoot} */ (target.shadowRoot);
      inner.querySelector('.acp-session-row__row')?.dispatchEvent(new PointerEvent('pointerenter'));
      await target.updateComplete;
      const more = /** @type {HTMLElement} */ (inner.querySelector('.acp-session-row__more'));

      more.click();
      await settle(el);
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (menuEl.menu);
      expect([menu.open, menu.anchorElement]).to.deep.equal([true, more]);
      expect(menuEl.sessionTitle).to.equal('Session a');
      expect(target.menuOpen, 'the row keeps its button').to.equal(true);
      expect(selects).to.have.length(0);

      for (const [value, type] of [['reveal', 'acp-session-reveal'], ['open-terminal', 'acp-session-open-terminal'], ['delete', 'acp-session-delete']]) {
        const heard = record(el, type);
        menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value }, bubbles: true, composed: true }));
        expect(heard.map((e) => e.detail), value).to.deep.equal([{ sessionId: 'a' }]);
      }
    });

    it('opens at the pointer on a right-click, offering Reset to agent title for a session the user renamed after the agent named it', async () => {
      const sessions = [session('u', { titleSource: 'user', agentTitle: 'Agent’s' }), session('p')];
      const { el, root } = await render({ sessions });
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      const resets = record(el, 'acp-session-reset-title');
      /** @param {string} title */
      const rightClick = async (title) => {
        row(root, title).shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }));
        await settle(el);
      };
      for (const title of ['Session u', 'Session p']) {
        await rightClick(title);
        expect(menuEl.menu?.open, title).to.equal(true);
        expect(menuEl.sessionTitle).to.equal(title);
        expect(menuEl.resettable, title).to.equal(title === 'Session u');
      }
      await rightClick('Session u');
      menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'reset-title' }, bubbles: true, composed: true }));
      expect(resets.map((e) => e.detail)).to.deep.equal([{ sessionId: 'u' }]);
    });

    it('renames the row in place when the menu says Rename', async () => {
      const { el, root } = await render();
      const target = row(root, 'Session a');
      target.shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }));
      await settle(el);
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value: 'rename' }, bubbles: true, composed: true }));
      await settle(el);
      expect(target.shadowRoot?.querySelector('.acp-session-row__rename'), 'its field').to.not.equal(null);
    });
  });

  it('shows the five newest chats, five more with each Show more', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${i}`, { lastActivityAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const { root } = await render({ sessions });
    expect(titles(root)).to.deep.equal(['Session s11', 'Session s10', 'Session s9', 'Session s8', 'Session s7']);
    const more = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-session-list__show-more'));
    expect(more()?.textContent?.trim()).to.equal('Show more…');
    more()?.click();
    await /** @type {AcpSessionList} */ (/** @type {ShadowRoot} */ (root).host).updateComplete;
    expect(titles(root)).to.have.length(10);
    more()?.click();
    await /** @type {AcpSessionList} */ (/** @type {ShadowRoot} */ (root).host).updateComplete;
    expect(titles(root)).to.have.length(12);
    expect(more(), 'all shown').to.equal(null);
  });

  it('ends Show more with the unread chats behind it', async () => {
    // Arrange
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${i}`, { lastActivityAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const hidden = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-session-list__show-more-new'));
    const more = () => /** @type {HTMLElement} */ (root.querySelector('.acp-session-list__show-more'));
    // Act
    const { el, root } = await render({ sessions, unread: ['s11', 's1', 's0'] });
    // Assert
    expect(more().getAttribute('aria-label')).to.equal('Show more chats, 2 unread');
    expect(hidden()?.textContent?.replace(/\s+/g, ' ').trim(), 'the count behind it').to.equal('2 new');
    expect(hidden()?.getAttribute('aria-hidden')).to.equal('true');

    // Act: the hidden ones are read
    el.unread = ['s11'];
    await el.updateComplete;
    // Assert
    expect(hidden() === null, 'nothing added').to.equal(true);
    expect(more().getAttribute('aria-label')).to.equal('Show more chats');
  });

  describe('read marks', () => {
    it('offers Mark as read on an unread row and Mark as unread on a read one, but only Mark as read on the shown session, and passes the pick on', async () => {
      // Arrange
      const { el, root } = await render({ unread: ['a', 'b'], activeSessionId: 'b' });
      const menuEl = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
      const marks = record(el, 'acp-session-mark-read');
      const cases = [
        // [title, mark, why]
        ['Session a', 'read', 'unread'],
        ['Session c', 'unread', 'read'],
        ['Session b', 'read', 'shown and unread (not seen)'],
      ];
      for (const [title, mark, why] of cases) {
        // Act
        row(root, title).shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }),
        );
        await settle(el);
        // Assert
        expect(menuEl.mark, why).to.equal(mark);
      }

      // Arrange: the shown session is read
      el.unread = ['a'];
      await el.updateComplete;
      row(root, 'Session b').shadowRoot?.querySelector('.acp-session-row__row')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      await settle(el);
      // Assert
      expect(menuEl.mark, 'shown and read').to.equal('');

      // Act
      for (const value of ['mark-read', 'mark-unread']) {
        menuEl.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value }, bubbles: true, composed: true }));
      }
      // Assert
      expect(marks.map((e) => e.detail)).to.deep.equal([
        { sessionId: 'b', read: true },
        { sessionId: 'b', read: false },
      ]);
    });
  });

  it("roots a chat's subagents in its row: open as they appear, closed and opened by its chevron or the arrows, and kept closed once the user closed it", async () => {
    // Arrange
    /** @param {string} id @returns {import('../../../hooks/sessions/types.js').Subagent} */
    const sub = (id) => ({ id, title: 'Find usages', description: 'Explore', state: 'running', stopReason: null, cancellable: true, announcedAt: '2026-01-01T00:00:00.000Z' });
    const { el, root } = await render({ subagents: { a: [sub('c1')] } });
    const rowA = row(root, 'Session a');
    const tree = () => /** @type {HTMLElementTagNameMap['acp-subagent-tree'] | null} */ (root.querySelector('acp-subagent-tree'));
    /** @param {string} key */
    const press = async (key) => {
      rowA.shadowRoot?.querySelector('[role="treeitem"]')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));
      await el.updateComplete;
    };
    const keys = record(el, 'keydown');
    // Assert: open as they appeared, under its row
    const order = [...root.querySelectorAll('acp-session-row, acp-subagent-tree')].map((n) =>
      n.localName === 'acp-subagent-tree' ? 'subagents' : /** @type {HTMLElementTagNameMap['acp-session-row']} */ (n).session?.title,
    );
    expect(order).to.deep.equal(['Session b', 'Session a', 'subagents', 'Session c']);
    expect([rowA.subagents, rowA.expanded, row(root, 'Session b').subagents]).to.deep.equal([1, true, 0]);
    // Act + Assert: a key inside them stays theirs
    tree()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
    expect(keys, 'not walked by the list').to.have.length(0);
    // Act + Assert: its chevron closes it, Right opens it, Left closes it
    rowA.dispatchEvent(new CustomEvent('acp-session-row-toggle', { detail: { sessionId: 'a', expanded: false }, bubbles: true, composed: true }));
    await el.updateComplete;
    expect(tree()).to.equal(null);
    rowA.focusRow();
    await press('ArrowRight');
    expect(tree()).to.not.equal(null);
    await press('ArrowLeft');
    expect(tree()).to.equal(null);
    // Act + Assert: closed by the user, it stays closed as more appear
    el.subagents = { a: [sub('c1'), sub('c2')] };
    await el.updateComplete;
    expect([rowA.subagents, tree()]).to.deep.equal([2, null]);
  });

  describe('as a tree', () => {
    /** @param {Element} rowEl @param {string} key */
    const press = (rowEl, key) =>
      rowEl.shadowRoot?.querySelector('[role="treeitem"]')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));
    /** @param {Element | null | undefined} el */
    const name = (el) => (el instanceof Element ? /** @type {HTMLElementTagNameMap['acp-session-row']} */ (el).session?.title : String(el));
    /** @param {ShadowRoot} root */
    const stops = (root) => [...root.querySelectorAll('acp-session-row')].filter((r) => r.tabStop).map(name);

    it('has one Tab stop, the first row until focus moves, and walks the rows with the arrows', async () => {
      // Arrange
      const { root } = await render();
      // Assert
      expect(root.querySelector('[role="tree"]')?.getAttribute('aria-label')).to.equal('Chats');
      expect(stops(root)).to.deep.equal(['Session b']);
      // Act
      row(root, 'Session b').focusRow();
      press(row(root, 'Session b'), 'ArrowDown');
      // Assert
      expect(name(root.activeElement)).to.equal('Session a');
      expect(stops(root)).to.deep.equal(['Session a']);
      // Act
      press(row(root, 'Session a'), 'End');
      // Assert
      expect(name(root.activeElement)).to.equal('Session c');
      // Act
      press(row(root, 'Session c'), 'Home');
      // Assert
      expect(name(root.activeElement)).to.equal('Session b');
    });
  });
});
