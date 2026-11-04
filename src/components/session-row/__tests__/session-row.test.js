import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../session-row.js';

/** @typedef {import('../session-row.js').AcpSessionRow} AcpSessionRow */
/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */

/**
 * @param {Partial<Session>} [fields]
 * @returns {Session}
 */
function session(fields = {}) {
  return {
    id: 'a',
    projectId: '/p',
    title: 'Session a',
    status: 'idle',
    agentId: 'a',
    config: {},
    folder: '/p',
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
    ...fields,
  };
}

/** @param {Partial<AcpSessionRow>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpSessionRow} */ (await fixture(html`<acp-session-row></acp-session-row>`));
  Object.assign(el, { session: session(), ...props });
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root, row: /** @type {HTMLElement} */ (root.querySelector('.acp-session-row__row')) };
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
 * Whether a selector matches: a failed `equal(null)` on an element makes chai walk the whole DOM node.
 * @param {ParentNode} root
 * @param {string} selector
 */
function has(root, selector) {
  return root.querySelector(selector) !== null;
}

describe('acp-session-row', () => {
  it('is a tree item at level 2 that is a Tab stop only while it holds the tree\'s', async () => {
    const { el, row } = await render();
    expect([row.getAttribute('role'), row.getAttribute('aria-level'), row.tabIndex]).to.deep.equal(['treeitem', '2', 0]);
    el.tabStop = false;
    await el.updateComplete;
    expect(row.tabIndex).to.equal(-1);
  });

  it('shows the title, a pin, the agent’s icon, the worktree branch and the age, with tooltips for its marks', async () => {
    const { root } = await render({
      session: session({ agentId: 'claude-code', agentName: 'Claude Code', branch: 'brama/r-1', title: 'Fix the tabs' }),
      pinned: true,
    });
    expect(root.querySelector('.acp-session-row__title')?.textContent?.trim()).to.equal('Fix the tabs');
    const agent = root.querySelector('.acp-session-row__agent');
    expect(agent?.getAttribute('brand')).to.equal('claude');
    expect(tooltipOf(agent)).to.equal('Claude Code');
    expect(tooltipOf(root.querySelector('.acp-session-row__pin'))).to.equal('Pinned');
    expect(tooltipOf(root.querySelector('.acp-session-row__branch'))).to.equal('Worktree on brama/r-1');
    expect(root.querySelector('.acp-session-row__age')?.textContent).to.match(/^\d+d$/);
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);

    const plain = await render({ session: session({ agentId: 'mine' }) });
    expect(plain.root.querySelector('.acp-session-row__agent')?.hasAttribute('brand')).to.equal(false);
    expect(tooltipOf(plain.root.querySelector('.acp-session-row__agent'))).to.equal('mine');
    expect(plain.root.querySelector('.acp-session-row__pin') ?? plain.root.querySelector('.acp-session-row__branch')).to.equal(null);
  });

  it('marks an unread row with a dot in the pin\'s place, a heavier title and a primary age; a read row has none of it, also with a status or the menu button', async () => {
    // Arrange
    const claude = session({ agentId: 'claude-code', agentName: 'Claude Code', status: 'working' });
    const { el, root, row } = await render({ session: claude, pinned: true, unread: true, waiting: true });

    // Assert: unread and pinned, waiting for a permission
    const dot = root.querySelector('.acp-session-row__unread-dot');
    expect(dot?.getAttribute('aria-hidden')).to.equal('true');
    expect(tooltipOf(dot)).to.equal('Unread · Claude Code');
    expect(has(root, '.acp-session-row__pin'), 'the dot, not the pin').to.equal(false);
    expect(row.classList.contains('acp-session-row__row_unread')).to.equal(true);
    expect(has(root, '.acp-session-row__title_unread')).to.equal(true);
    expect(has(root, '.acp-session-row__age_unread')).to.equal(true);
    expect(root.querySelector('acp-session-status')?.indicator, 'the dot and a status at once').to.equal('permission');
    expect(has(root, '[title]'), 'tooltips, not titles').to.equal(false);

    // Act: the menu opens, its button takes the status's place
    el.menuOpen = true;
    await el.updateComplete;

    // Assert
    expect(has(root, '.acp-session-row__more'), 'the menu button replaces the status').to.equal(true);
    expect(has(root, '.acp-session-row__unread-dot'), 'the dot stays').to.equal(true);
    expect(has(root, '.acp-session-row__age_unread'), 'so does the age').to.equal(true);

    // Act: read again
    el.unread = false;
    el.menuOpen = false;
    await el.updateComplete;

    // Assert
    expect(has(root, '.acp-session-row__unread-dot')).to.equal(false);
    expect(has(root, '.acp-session-row__pin'), 'a read pinned row has its pin').to.equal(true);
    expect(row.classList.contains('acp-session-row__row_unread')).to.equal(false);
    expect(has(root, '.acp-session-row__title_unread, .acp-session-row__age_unread')).to.equal(false);
  });

  it('names the row for assistive tech: title, agent, unread, pinned, worktree, age and status', async () => {
    // Arrange
    const now = Date.parse('2026-10-23T13:00:00.000Z');
    const full = session({
      title: 'Session-input spec gaps',
      agentId: 'claude-code',
      agentName: 'Claude Code',
      branch: 'brama/r-1',
      status: 'error',
      lastActivityAt: '2026-10-23T12:47:00.000Z',
    });
    // Act
    const { row } = await render({ session: full, now, unread: true, pinned: true });

    // Assert
    expect(row.getAttribute('aria-label')).to.equal(
      'Session-input spec gaps, Claude Code, unread, pinned, worktree on brama/r-1, 13 minutes ago, Last turn failed',
    );
    const plain = session({ title: 'Plain', agentId: 'mine', lastActivityAt: '2026-10-23T12:00:00.000Z' });
    expect((await render({ session: plain, now })).row.getAttribute('aria-label')).to.equal('Plain, mine, 1 hour ago');
  });

  it('marks the row whose menu is open', async () => {
    // Arrange
    const { el, row } = await render();
    expect(row.classList.contains('acp-session-row__row_menu-open')).to.equal(false);

    // Act
    el.menuOpen = true;
    await el.updateComplete;

    // Assert
    expect(row.classList.contains('acp-session-row__row_menu-open')).to.equal(true);
  });

  it('passes its state to the status and marks the selected row', async () => {
    const now = Date.parse('2026-10-23T13:00:00.000Z');
    const soon = '2026-10-23T13:01:00.000Z';
    const past = '2026-10-23T12:59:00.000Z';
    /** @type {[string, Partial<AcpSessionRow>, string | null][]} */
    const cases = [
      ['running', { session: session({ status: 'working' }) }, 'running'],
      ['error', { session: session({ status: 'error' }) }, 'error'],
      ['permission', { waiting: true }, 'permission'],
      ['unread alone shows none', { unread: true }, null],
      ['elsewhere', { session: session({ status: 'stopped', activeElsewhereUntil: soon }) }, 'elsewhere'],
      ['its time is up', { session: session({ status: 'stopped', activeElsewhereUntil: past }) }, null],
      ['terminal working', { session: session({ status: 'stopped', inTerminal: true, activity: 'running' }) }, 'terminal-working'],
      ['idle terminal', { session: session({ status: 'stopped', inTerminal: true }) }, null],
    ];
    for (const [why, props, expected] of cases) {
      const { root } = await render({ now, ...props });
      const status = /** @type {HTMLElementTagNameMap['acp-session-status']} */ (root.querySelector('acp-session-status'));
      expect(status.indicator, why).to.equal(expected);
    }
    const selected = await render({ selected: true });
    expect(selected.row.getAttribute('aria-selected')).to.equal('true');
    expect((await render()).row.getAttribute('aria-selected')).to.equal('false');
  });

  it('swaps the status for a menu button while hovered, focused or its menu is open, and asks for the menu under it without selecting', async () => {
    const { el, root, row } = await render({ unread: true });
    const selects = record(el, 'acp-session-select');
    const menus = record(el, 'acp-session-row-menu');
    expect(root.querySelector('.acp-session-row__more')).to.equal(null);
    row.dispatchEvent(new PointerEvent('pointerenter'));
    await el.updateComplete;
    expect(root.querySelector('acp-session-status'), 'the status is swapped out').to.equal(null);
    row.dispatchEvent(new PointerEvent('pointerleave'));
    await el.updateComplete;
    expect(root.querySelector('.acp-session-row__more')).to.equal(null);
    row.dispatchEvent(new FocusEvent('focusin'));
    await el.updateComplete;
    row.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
    await el.updateComplete;
    expect(root.querySelector('.acp-session-row__more'), 'focus left').to.equal(null);
    el.menuOpen = true;
    await el.updateComplete;
    const more = /** @type {HTMLElement} */ (root.querySelector('.acp-session-row__more'));
    expect(tooltipOf(more)).to.equal('Session menu');

    more.click();
    expect(menus).to.have.length(1);
    expect(menus[0].detail.anchor).to.equal(more);
    expect(menus[0].detail.session.id).to.equal('a');
    expect(selects, 'not selected').to.have.length(0);
  });

  it('selects on a click, Enter or Space, and asks for the menu at the pointer on a right-click and under the row on ContextMenu or Shift+F10', async () => {
    const { el, row } = await render();
    const selects = record(el, 'acp-session-select');
    const menus = record(el, 'acp-session-row-menu');
    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(selects.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a' }, { sessionId: 'a' }, { sessionId: 'a' }]);
    const click = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 7 });
    row.dispatchEvent(click);
    expect(click.defaultPrevented).to.equal(true);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', cancelable: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, cancelable: true }));
    expect(menus.map((e) => [e.detail.anchor, typeof e.detail.x]), 'at a point, not under a button').to.deep.equal([[undefined, 'number'], [undefined, 'number'], [undefined, 'number']]);
    expect([menus[0].detail.x, menus[0].detail.y]).to.deep.equal([5, 7]);
    const rect = row.getBoundingClientRect();
    expect([menus[1].detail.x, menus[1].detail.y]).to.deep.equal([rect.left + 24, rect.bottom]);
    expect(selects, 'the menu keys do not select').to.have.length(3);
  });

  it('edits the title in place on F2, a double-click or startRename() and saves on Enter; Escape, an empty or an unchanged title keep it', async () => {
    const { el, root, row } = await render();
    const renames = record(el, 'acp-session-rename');
    /** @param {ParentNode} parent */
    const field = async (parent) => {
      await new Promise((r) => setTimeout(r, 0));
      return /** @type {HTMLElementTagNameMap['md-text-field'] | null} */ (parent.querySelector('.acp-session-row__rename'));
    };
    // F2, then Enter saves
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
    const input = /** @type {HTMLElementTagNameMap['md-text-field']} */ (await field(root));
    expect(input.value).to.equal('Session a');
    input.value = 'Gaps';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await el.updateComplete;
    expect(renames.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a', title: 'Gaps' }]);
    expect(root.querySelector('.acp-session-row__rename')).to.equal(null);
    expect(root.activeElement, 'focus back on the row').to.equal(row);
    // a double-click and startRename() start it too
    row.dispatchEvent(new MouseEvent('dblclick'));
    expect(await field(root)).to.not.equal(null);
    el.renaming = false;
    await el.updateComplete;
    el.startRename();
    expect(await field(root)).to.not.equal(null);
    // these keep the title
    for (const [value, key] of [['Other', 'Escape'], ['  ', 'Enter'], ['Session a', 'Enter']]) {
      const open = await field(root);
      /** @type {HTMLElementTagNameMap['md-text-field']} */ (open).value = value;
      open?.dispatchEvent(new KeyboardEvent('keydown', { key }));
      await el.updateComplete;
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
    }
    expect(renames, 'nothing more was saved').to.have.length(1);
  });

  it('is the root of its subagents: a chevron and aria-expanded only with some, which asks to open or close them without selecting', async () => {
    // Arrange
    const plain = await render();
    const { el, row, root } = await render({ subagents: 3, expanded: false });
    const toggles = record(el, 'acp-session-row-toggle');
    const selects = record(el, 'acp-session-select');
    const chevron = /** @type {HTMLElement} */ (root.querySelector('.acp-session-row__toggle'));
    // Act
    chevron.click();
    el.expanded = true;
    await el.updateComplete;
    chevron.click();
    // Assert
    expect(plain.row.hasAttribute('aria-expanded'), 'no subagents: a leaf').to.equal(false);
    expect(plain.root.querySelector('.acp-session-row__toggle')).to.equal(null);
    expect(row.getAttribute('aria-expanded')).to.equal('true');
    expect(chevron.getAttribute('aria-label')).to.equal('Hide 3 subagents');
    expect(toggles.map((e) => e.detail)).to.deep.equal([
      { sessionId: 'a', expanded: true },
      { sessionId: 'a', expanded: false },
    ]);
    expect(selects, 'the chevron only toggles').to.have.length(0);
  });
});
