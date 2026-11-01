import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../tab-overflow.js';

/** @typedef {import('../tab-overflow.js').AcpTabOverflow} AcpTabOverflow */
/** @typedef {import('../tab-overflow.js').TabOverflowItem} TabOverflowItem */

/**
 * @param {string} id
 * @param {Partial<TabOverflowItem>} [fields]
 * @returns {TabOverflowItem}
 */
const item = (id, fields = {}) => ({ id, title: id.toUpperCase(), icon: '', file: `${id}.js`, tooltip: `/p/${id}.js`, pinned: false, unsaved: false, deleted: false, ...fields });

/** @param {Partial<AcpTabOverflow>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpTabOverflow} */ (await fixture(html`<acp-tab-overflow></acp-tab-overflow>`));
  Object.assign(el, { visible: true, items: [item('a'), item('b'), item('c')], active: 'b', ...props });
  await el.updateComplete;
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  const menu = () => /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-tab-overflow__menu'));
  const rows = () => /** @type {HTMLElementTagNameMap['md-menu-item'][]} */ ([...menu().querySelectorAll('.acp-tab-overflow__item')]);
  const button = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-tab-overflow__button'));
  return { el, root, menu, rows, button };
}

/**
 * @param {HTMLElement} el
 * @param {string} type
 */
function listen(el, type) {
  /** @type {unknown[]} */
  const details = [];
  el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
  return details;
}

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Opens the list from its button. @param {Awaited<ReturnType<typeof render>>} view */
async function open(view) {
  /** @type {HTMLElement} */ (view.button()).click();
  await until(() => view.menu().open);
  await view.el.updateComplete;
}

describe('acp-tab-overflow', () => {
  it('shows its button only while visible, and lists the tabs with the active one selected', async () => {
    const hidden = await render({ visible: false });
    expect(hidden.button()).to.equal(null);
    const view = await render({ items: [item('a', { file: null, icon: '<svg id="own"></svg>' }), item('b'), item('c')] });
    expect(view.button()?.getAttribute('aria-label')).to.equal('Show Hidden Tabs');
    expect(tooltipOf(view.button())).to.equal('Show Hidden Tabs');
    expect(view.button()?.getAttribute('aria-expanded')).to.equal('false');
    await open(view);
    expect(view.button()?.getAttribute('aria-expanded')).to.equal('true');
    expect(view.rows().map((r) => [r.getAttribute('value'), r.hasAttribute('selected')])).to.deep.equal([['a', false], ['b', true], ['c', false]]);
    expect(view.rows()[0].querySelector('#own'), 'a view tab’s own icon').to.not.equal(null);
    expect(view.rows()[1].querySelector('acp-file-icon')?.getAttribute('name'), 'a file tab’s').to.equal('b.js');
  });

  it('marks unsaved and deleted tabs and explains each mark in a tooltip, not a title', async () => {
    const view = await render({ items: [item('a', { unsaved: true, deleted: true }), item('b', { pinned: true })] });
    await open(view);
    const [a, b] = view.rows();
    expect(a.querySelector('.acp-tab-overflow__title_deleted')?.textContent).to.equal('A');
    expect(a.querySelector('.acp-tab-overflow__unsaved')).to.not.equal(null);
    expect(b.querySelector('.acp-tab-overflow__unsaved')).to.equal(null);
    expect(tooltipOf(a.querySelector('.acp-tab-overflow__unsaved'))).to.equal('Unsaved changes');
    expect(tooltipOf(a.querySelector('.acp-tab-overflow__close'))).to.equal('Close');
    expect(a.querySelector('.acp-tab-overflow__close')?.getAttribute('aria-label')).to.equal('Close A');
    expect(tooltipOf(b.querySelector('.acp-tab-overflow__close')), 'a pinned tab’s × unpins').to.equal('Unpin');
    expect(b.querySelector('.acp-tab-overflow__close')?.getAttribute('aria-label')).to.equal('Unpin B');
    expect(view.root.querySelector('[title]')).to.equal(null);
  });

  it('activates a picked row and closes the list, telling the strip', async () => {
    const view = await render();
    await open(view);
    const activations = listen(view.el, 'acp-tab-activate');
    const closed = listen(view.el, 'acp-tab-overflow-closed');
    /** @type {HTMLElement} */ (view.rows()[2].shadowRoot?.querySelector('.md-menu-item__interactive')).click();
    await until(() => !view.menu().open);
    expect(activations).to.deep.equal([{ id: 'c' }]);
    await until(() => closed.length > 0);
  });

  it('asks to close a tab with its × or Delete without activating it, keeping the list open', async () => {
    const view = await render();
    await open(view);
    const closes = listen(view.el, 'acp-tab-overflow-close');
    const activations = listen(view.el, 'acp-tab-activate');
    /** @type {HTMLElement} */ (view.rows()[0].querySelector('.acp-tab-overflow__close')).click();
    view.rows()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true, cancelable: true }));
    expect(closes).to.deep.equal([{ id: 'a' }, { id: 'c' }]);
    expect(activations).to.deep.equal([]);
    expect(view.menu().open).to.equal(true);
  });

  it('keeps the list open on the remaining rows when Delete closes one, and closes it once none is left', async () => {
    const view = await render();
    await open(view);
    view.rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true, cancelable: true }));
    view.el.items = [item('a'), item('c')];
    await view.el.updateComplete;
    expect(view.rows().map((r) => r.getAttribute('value'))).to.deep.equal(['a', 'c']);
    expect(view.menu().open).to.equal(true);

    view.el.items = [];
    await view.el.updateComplete;
    await until(() => !view.menu().open);
  });

  it('opens on ArrowDown on its button, and Escape closes the list', async () => {
    const view = await render();
    /** @type {HTMLElement} */ (view.button()).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    await until(() => view.menu().open);
    view.menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !view.menu().open);
    expect(view.el.open).to.equal(false);
  });
});
