import { expect, fixture, html } from '../../../../test/fixture.js';
import '../session-menu.js';

/** @typedef {import('../session-menu.js').AcpSessionMenu} AcpSessionMenu */
/** @typedef {HTMLElementTagNameMap['md-menu']} MdMenu */

/**
 * @param {import('lit').TemplateResult} template
 * @returns {Promise<{ el: AcpSessionMenu, menu: MdMenu }>}
 */
async function render(template) {
  const el = /** @type {AcpSessionMenu} */ (await fixture(template));
  const menu = /** @type {MdMenu} */ (/** @type {ShadowRoot} */ (el.shadowRoot).querySelector('md-menu'));
  return { el, menu };
}

/**
 * @param {AcpSessionMenu} el
 * @param {string} type
 * @returns {CustomEvent[]}
 */
function record(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

describe('acp-session-menu', () => {
  it('opens and closes from the element it is anchored to, until unanchored', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const { el, menu } = await render(html`<acp-session-menu session-title="Fix the tree"></acp-session-menu>`);
    el.anchor = button;
    await el.updateComplete;
    await menu.updateComplete;
    expect(menu.anchorElement).to.equal(button);
    expect(menu.getAttribute('aria-label')).to.equal('Fix the tree');
    expect(button.getAttribute('aria-haspopup')).to.equal('menu');
    button.click();
    expect(menu.open).to.equal(true);
    button.click();
    expect(menu.open).to.equal(false);

    el.anchor = null;
    await el.updateComplete;
    expect(button.hasAttribute('aria-haspopup')).to.equal(false);
    button.click();
    expect(menu.open).to.equal(false);
    button.remove();
  });

  it('keeps the actions with no backend yet disabled', async () => {
    const { el } = await render(html`<acp-session-menu></acp-session-menu>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const disabled = [...root.querySelectorAll('md-menu-item[disabled]')].map((i) => i.getAttribute('value'));
    expect(disabled).to.deep.equal(['export', 'archive']);
  });

  it('reports the picked action', async () => {
    const { el, menu } = await render(html`<acp-session-menu></acp-session-menu>`);
    const events = record(el, 'acp-session-menu-select');
    el.mark = 'read';
    await el.updateComplete;
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    for (const value of ['mark-read', 'rename', 'reveal', 'open-terminal', 'delete']) {
      const item = /** @type {HTMLElement} */ (root.querySelector(`md-menu-item[value="${value}"]`));
      menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
    }
    expect(events.map((e) => e.detail)).to.deep.equal([
      { value: 'mark-read' },
      { value: 'rename' },
      { value: 'reveal' },
      { value: 'open-terminal' },
      { value: 'delete' },
    ]);
  });

  it('reports a pick in the Open in submenu once', async () => {
    const { el } = await render(html`<acp-session-menu></acp-session-menu>`);
    const events = record(el, 'acp-session-menu-select');
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const item = /** @type {HTMLElement} */ (root.querySelector('md-menu-item[value="open-terminal"]'));
    // What a click on it fires; both menus pass it on.
    item.dispatchEvent(new CustomEvent('select', { detail: { value: 'open-terminal', item }, bubbles: true, composed: true }));
    expect(events.map((e) => e.detail)).to.deep.equal([{ value: 'open-terminal' }]);
  });

  it('reports opening and closing', async () => {
    const { el, menu } = await render(html`<acp-session-menu></acp-session-menu>`);
    const events = record(el, 'acp-session-menu-toggle');
    const closed = record(el, 'acp-session-menu-closed');
    menu.dispatchEvent(new Event('opening'));
    menu.dispatchEvent(new Event('closing'));
    expect(events.map((e) => e.detail)).to.deep.equal([{ open: true }, { open: false }]);
    menu.dispatchEvent(new Event('closed'));
    expect(closed).to.have.length(1);
  });

  it('opens at a point, for a context menu', async () => {
    const { el, menu } = await render(html`<acp-session-menu></acp-session-menu>`);
    el.openAtPoint(10, 20);
    expect(menu.open).to.equal(true);
  });

  it('closes any other menu when it opens: one menu at a time', async () => {
    const { el: first, menu: firstMenu } = await render(html`<acp-session-menu></acp-session-menu>`);
    const { el: second } = await render(html`<acp-session-menu></acp-session-menu>`);
    first.openAtPoint(0, 0);
    second.openAtPoint(10, 10);
    expect(firstMenu.open).to.equal(false);
  });

  it('leads with Mark as read or Mark as unread as asked, and with neither by default', async () => {
    // Arrange
    const { el } = await render(html`<acp-session-menu></acp-session-menu>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const first = () => root.querySelector('md-menu > md-item-group:first-of-type > md-menu-item');
    expect(root.querySelector('md-menu-item[value^="mark-"]'), 'the header passes no mark').to.equal(null);
    expect(first()?.getAttribute('value')).to.equal('open-in');

    // Act + Assert: an item per mark, always first
    el.mark = 'unread';
    await el.updateComplete;
    expect(first()?.getAttribute('value')).to.equal('mark-unread');
    expect(first()?.textContent).to.contain('Mark as unread');
    el.mark = 'read';
    await el.updateComplete;
    expect(first()?.getAttribute('value')).to.equal('mark-read');
    expect(first()?.textContent).to.contain('Mark as read');
    expect(root.querySelectorAll('md-menu-item[value^="mark-"]')).to.have.length(1);
  });

  it('offers Pin or Unpin as asked, and neither by default', async () => {
    // Arrange
    const el = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (await fixture(html`<acp-session-menu></acp-session-menu>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const values = () => [...root.querySelectorAll('md-menu-item[value$="pin"]')].map((item) => item.getAttribute('value'));
    // Assert
    expect(values(), 'the header passes none').to.deep.equal([]);
    for (const pin of /** @type {('pin' | 'unpin')[]} */ (['pin', 'unpin'])) {
      // Act
      el.pin = pin;
      await el.updateComplete;
      // Assert
      expect(values()).to.deep.equal([pin]);
    }
  });

  it('offers Reset to agent title only when asked to', async () => {
    const { el } = await render(html`<acp-session-menu></acp-session-menu>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(root.querySelector('md-menu-item[value="reset-title"]')).to.equal(null);
    el.resettable = true;
    await el.updateComplete;
    expect(root.querySelector('md-menu-item[value="reset-title"]')?.textContent).to.contain('Reset to agent title');
  });
});
