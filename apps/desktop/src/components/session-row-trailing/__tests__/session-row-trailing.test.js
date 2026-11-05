import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../session-row-trailing.js';

/** @typedef {import('../session-row-trailing.js').AcpSessionRowTrailing} AcpSessionRowTrailing */
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

/** @param {Partial<AcpSessionRowTrailing>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpSessionRowTrailing} */ (
    await fixture(html`<acp-session-row-trailing .session=${session()}></acp-session-row-trailing>`)
  );
  Object.assign(el, props);
  await el.updateComplete;
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * @param {Element} el
 * @returns {string[]} The row events it heard.
 */
function heard(el) {
  /** @type {string[]} */
  const events = [];
  for (const type of ['acp-session-select', 'acp-session-pin', 'acp-session-mark-read', 'acp-session-row-menu', 'acp-session-row-toggle']) {
    el.addEventListener(type, () => events.push(type));
  }
  return events;
}

describe('acp-session-row-trailing', () => {
  it('shows a pinned mark, the worktree branch, the age and the status, with tooltips for its marks', async () => {
    // Arrange + Act
    const { root } = await render({
      session: session({ branch: 'feature/x', status: 'working' }),
      pinned: true,
      now: Date.parse('2026-01-01T02:00:00.000Z'),
    });
    // Assert
    const pin = root.querySelector('.acp-session-row-trailing__pinned');
    const branch = root.querySelector('.acp-session-row-trailing__branch');
    expect(tooltipOf(/** @type {HTMLElement} */ (pin))).to.equal('Pinned');
    expect(tooltipOf(/** @type {HTMLElement} */ (branch))).to.equal('Worktree on feature/x');
    expect(root.querySelector('acp-datetime')?.textContent ?? root.querySelector('acp-datetime')?.shadowRoot?.textContent).to.contain('2h');
    const status = /** @type {HTMLElementTagNameMap['acp-session-status']} */ (root.querySelector('acp-session-status'));
    expect(status.session?.status).to.equal('working');
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
  });

  it('offers Mark as read only while unread, and passes it on without selecting', async () => {
    // Arrange
    const { el, root } = await render();
    const events = heard(el);
    // Assert
    expect(root.querySelector('.acp-session-row-trailing__mark-read'), 'read').to.equal(null);
    // Act
    el.unread = true;
    await el.updateComplete;
    /** @type {CustomEvent[]} */
    const marks = [];
    el.addEventListener('acp-session-mark-read', (e) => marks.push(/** @type {CustomEvent} */ (e)));
    /** @type {HTMLElement} */ (root.querySelector('.acp-session-row-trailing__mark-read')).click();
    // Assert
    expect(marks.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a', read: true }]);
    expect(events).to.deep.equal(['acp-session-mark-read']);
  });

  it('pins and unpins with its button, whose tooltip says which', async () => {
    for (const [pinned, label, next] of /** @type {[boolean, string, boolean][]} */ ([[false, 'Pin', true], [true, 'Unpin', false]])) {
      // Arrange
      const { el, root } = await render({ pinned });
      /** @type {CustomEvent[]} */
      const pins = [];
      el.addEventListener('acp-session-pin', (e) => pins.push(/** @type {CustomEvent} */ (e)));
      const button = /** @type {HTMLElement} */ (root.querySelector('.acp-session-row-trailing__pin'));
      // Act
      button.click();
      // Assert
      expect(tooltipOf(button), label).to.equal(label);
      expect(button.getAttribute('aria-label'), label).to.equal(`${label}: Session a`);
      expect(pins.map((e) => e.detail), label).to.deep.equal([{ sessionId: 'a', pinned: next }]);
    }
  });

  it('asks for the menu under its button', async () => {
    // Arrange
    const { el, root } = await render();
    /** @type {CustomEvent[]} */
    const menus = [];
    el.addEventListener('acp-session-row-menu', (e) => menus.push(/** @type {CustomEvent} */ (e)));
    const more = /** @type {HTMLElement} */ (root.querySelector('.acp-session-row-trailing__more'));
    // Act
    more.click();
    // Assert
    expect(menus.map((e) => e.detail.anchor)).to.deep.equal([more]);
    expect(menus[0].detail.session.id).to.equal('a');
  });

  it("keeps its buttons' clicks and double-clicks from the row", async () => {
    // Arrange
    const { el, root } = await render({ unread: true, subagents: 1 });
    const parent = /** @type {HTMLElement} */ (el.parentElement);
    /** @type {string[]} */
    const reached = [];
    for (const type of ['click', 'dblclick']) parent.addEventListener(type, () => reached.push(type));
    // Act
    for (const button of root.querySelectorAll('md-icon-button')) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    }
    // Assert
    expect(reached).to.deep.equal([]);
  });

  it('has a chevron only with subagents, which asks to open or close them', async () => {
    // Arrange
    const { el, root } = await render();
    const toggle = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-session-row-trailing__toggle'));
    // Assert
    expect(toggle(), 'none').to.equal(null);
    // Act
    el.subagents = 2;
    el.expanded = true;
    await el.updateComplete;
    /** @type {CustomEvent[]} */
    const toggles = [];
    el.addEventListener('acp-session-row-toggle', (e) => toggles.push(/** @type {CustomEvent} */ (e)));
    toggle()?.click();
    // Assert
    expect(toggle()?.getAttribute('aria-label')).to.equal('Hide 2 subagents');
    expect(toggles.map((e) => e.detail)).to.deep.equal([{ sessionId: 'a', expanded: false }]);
  });
});
