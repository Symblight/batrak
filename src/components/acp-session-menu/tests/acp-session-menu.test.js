import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-session-menu.js';

/** @typedef {import('../acp-session-menu.js').AcpSessionMenu} AcpSessionMenu */
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
    expect(disabled).to.deep.equal(['open-in', 'open-terminal', 'export', 'archive']);
  });

  it('reports the picked action', async () => {
    const { el, menu } = await render(html`<acp-session-menu></acp-session-menu>`);
    const events = record(el, 'acp-session-menu-select');
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    for (const value of ['rename', 'reveal', 'delete']) {
      const item = /** @type {HTMLElement} */ (root.querySelector(`md-menu-item[value="${value}"]`));
      menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
    }
    expect(events.map((e) => e.detail)).to.deep.equal([{ value: 'rename' }, { value: 'reveal' }, { value: 'delete' }]);
  });

  it('reports opening and closing', async () => {
    const { el, menu } = await render(html`<acp-session-menu></acp-session-menu>`);
    const events = record(el, 'acp-session-menu-toggle');
    menu.dispatchEvent(new Event('opening'));
    menu.dispatchEvent(new Event('closing'));
    expect(events.map((e) => e.detail)).to.deep.equal([{ open: true }, { open: false }]);
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
});
