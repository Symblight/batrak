import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-session-header.js';

/** @typedef {import('../acp-session-header.js').AcpSessionHeader} AcpSessionHeader */

/**
 * @param {import('lit').TemplateResult} template
 * @returns {Promise<{ el: AcpSessionHeader, root: ShadowRoot }>}
 */
async function render(template) {
  const el = /** @type {AcpSessionHeader} */ (await fixture(template));
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/**
 * Picks a menu item as `md-menu` reports it.
 * @param {ShadowRoot} root
 * @param {string} value
 */
function pick(root, value) {
  const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
  const item = /** @type {HTMLElement} */ (root.querySelector(`md-menu-item[value="${value}"]`));
  menu.dispatchEvent(new CustomEvent('select', { detail: { value, item } }));
}

/**
 * @param {AcpSessionHeader} el
 * @param {string} type
 * @returns {CustomEvent[]}
 */
function record(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

describe('acp-session-header', () => {
  it('shows the title on a button that opens the session menu', async () => {
    const { root } = await render(html`<acp-session-header session-title="Fix the tree"></acp-session-header>`);
    const button = /** @type {HTMLElement} */ (root.querySelector('.acp-session-header__title-button'));
    expect(button.textContent).to.contain('Fix the tree');
    expect(button.getAttribute('aria-label')).to.equal('Session menu: Fix the tree');
    const menu = /** @type {HTMLElement & { open: boolean }} */ (root.querySelector('md-menu'));
    button.click();
    expect(menu.open).to.equal(true);
  });

  it('shows a draft as a new session, with no menu', async () => {
    const { root } = await render(html`<acp-session-header draft></acp-session-header>`);
    expect(root.querySelector('.acp-session-header__title')?.textContent).to.equal('New session');
    expect(root.querySelector('.acp-session-header__title-button')).to.equal(null);
    expect(root.querySelector('md-menu')).to.equal(null);
  });

  it('shows the status only while the session isn’t idle', async () => {
    const { el, root } = await render(html`<acp-session-header session-title="T"></acp-session-header>`);
    expect(root.querySelector('.acp-session-header__status')).to.equal(null);
    el.indicator = 'permission';
    await el.updateComplete;
    expect(root.querySelector('.acp-session-header__status')?.getAttribute('aria-label')).to.equal(
      'Waiting for your permission',
    );
    el.indicator = 'running';
    await el.updateComplete;
    const status = root.querySelector('.acp-session-header__status');
    expect(status?.getAttribute('aria-label')).to.equal('Agent is working');
    expect(status?.querySelector('md-progress-circular')).to.not.equal(null);
  });

  it('keeps the actions with no backend yet disabled', async () => {
    const { root } = await render(html`<acp-session-header session-title="T"></acp-session-header>`);
    const disabled = [...root.querySelectorAll('md-menu-item[disabled]')].map((i) => i.getAttribute('value'));
    expect(disabled).to.deep.equal(['open-in', 'open-terminal', 'export', 'archive']);
  });

  it('asks the column to reveal or delete the session', async () => {
    const { el, root } = await render(html`<acp-session-header session-title="T"></acp-session-header>`);
    const reveals = record(el, 'acp-session-reveal');
    const deletes = record(el, 'acp-session-delete');
    pick(root, 'reveal');
    pick(root, 'delete');
    expect(reveals).to.have.length(1);
    expect(deletes).to.have.length(1);
  });

  it('asks for a new session from its trailing button', async () => {
    const { el, root } = await render(html`<acp-session-header session-title="T"></acp-session-header>`);
    const events = record(el, 'acp-session-new');
    /** @type {HTMLElement} */ (root.querySelector('.acp-session-header__new')).click();
    expect(events).to.have.length(1);
  });

  describe('rename', () => {
    /** @param {AcpSessionHeader} el */
    async function startRename(el) {
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const button = /** @type {HTMLElement} */ (root.querySelector('.acp-session-header__title-button'));
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, composed: true }));
      await el.updateComplete;
      return /** @type {HTMLElementTagNameMap['md-text-field']} */ (root.querySelector('.acp-session-header__rename'));
    }

    it('swaps the title for a field with its text selected on F2 or the menu’s Rename', async () => {
      const { el, root } = await render(html`<acp-session-header session-title="Fix the tree"></acp-session-header>`);
      const input = await startRename(el);
      expect(input.value).to.equal('Fix the tree');
      expect(root.activeElement).to.equal(input);
      const native = /** @type {HTMLInputElement} */ (input.inputOrTextArea);
      expect([native.selectionStart, native.selectionEnd]).to.deep.equal([0, 12]);
      expect(root.querySelector('.acp-session-header__title-button')).to.equal(null);

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;
      pick(root, 'rename');
      await el.updateComplete;
      expect(root.querySelector('.acp-session-header__rename')).to.not.equal(null);
    });

    it('saves on Enter', async () => {
      const { el, root } = await render(html`<acp-session-header session-title="Fix the tree"></acp-session-header>`);
      const events = record(el, 'acp-session-rename');
      const input = await startRename(el);
      input.value = '  TreeView gaps ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await el.updateComplete;
      expect(events.map((e) => e.detail)).to.deep.equal([{ title: 'TreeView gaps' }]);
      expect(root.querySelector('.acp-session-header__rename')).to.equal(null);
    });

    it('saves when the field loses focus', async () => {
      const { el } = await render(html`<acp-session-header session-title="Fix the tree"></acp-session-header>`);
      const events = record(el, 'acp-session-rename');
      const input = await startRename(el);
      input.value = 'TreeView gaps';
      // Not `blur()`: a test page without window focus gets no focus events.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
      await el.updateComplete;
      expect(events.map((e) => e.detail)).to.deep.equal([{ title: 'TreeView gaps' }]);
    });

    it('keeps the title on Escape, or when it’s left empty or unchanged', async () => {
      const { el } = await render(html`<acp-session-header session-title="Fix the tree"></acp-session-header>`);
      const events = record(el, 'acp-session-rename');
      for (const [value, key] of [
        ['Other', 'Escape'],
        ['   ', 'Enter'],
        ['Fix the tree', 'Enter'],
      ]) {
        const input = await startRename(el);
        input.value = value;
        input.dispatchEvent(new KeyboardEvent('keydown', { key }));
        await el.updateComplete;
      }
      expect(events).to.have.length(0);
    });

    it('gives focus back to the title button when it ends', async () => {
      const { el, root } = await render(html`<acp-session-header session-title="Fix the tree"></acp-session-header>`);
      const input = await startRename(el);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;
      expect(root.activeElement).to.equal(root.querySelector('.acp-session-header__title-button'));
    });
  });
});
