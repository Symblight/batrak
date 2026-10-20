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
 * Picks a menu item as `<acp-session-menu>` reports it.
 * @param {ShadowRoot} root
 * @param {string} value
 */
function pick(root, value) {
  const menu = /** @type {HTMLElement} */ (root.querySelector('acp-session-menu'));
  menu.dispatchEvent(new CustomEvent('acp-session-menu-select', { detail: { value }, bubbles: true, composed: true }));
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
    const { root } = await render(html`<acp-session-header session-id="s1" session-title="Fix the tree"></acp-session-header>`);
    const button = /** @type {HTMLElement} */ (root.querySelector('.acp-session-header__title-button'));
    expect(button.textContent).to.contain('Fix the tree');
    expect(button.getAttribute('aria-label')).to.equal('Session menu: Fix the tree');
    const menu = /** @type {HTMLElementTagNameMap['acp-session-menu']} */ (root.querySelector('acp-session-menu'));
    expect(menu.anchor).to.equal(button);
    expect(menu.sessionTitle).to.equal('Fix the tree');
  });

  it('flips the chevron while the menu is open', async () => {
    const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="T"></acp-session-header>`);
    const menu = /** @type {HTMLElement} */ (root.querySelector('acp-session-menu'));
    menu.dispatchEvent(new CustomEvent('acp-session-menu-toggle', { detail: { open: true } }));
    await el.updateComplete;
    expect(root.querySelector('.acp-session-header__chevron_flipped')).to.not.equal(null);
    menu.dispatchEvent(new CustomEvent('acp-session-menu-toggle', { detail: { open: false } }));
    await el.updateComplete;
    expect(root.querySelector('.acp-session-header__chevron_flipped')).to.equal(null);
  });

  it('shows a draft as a new session, with no menu', async () => {
    const { root } = await render(html`<acp-session-header draft></acp-session-header>`);
    expect(root.querySelector('.acp-session-header__title')?.textContent).to.equal('New session');
    expect(root.querySelector('.acp-session-header__title-button')).to.equal(null);
    expect(root.querySelector('acp-session-menu')).to.equal(null);
  });

  it('shows the session’s status', async () => {
    const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="T"></acp-session-header>`);
    el.indicator = 'permission';
    await el.updateComplete;
    const status = /** @type {HTMLElementTagNameMap['acp-session-status']} */ (root.querySelector('acp-session-status'));
    expect(status.indicator).to.equal('permission');
  });

  it('asks the column for the menu’s actions, naming the session', async () => {
    const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="T"></acp-session-header>`);
    const types = ['acp-session-reveal', 'acp-session-delete'];
    /** @type {[string, unknown][]} */
    const seen = [];
    for (const type of types) el.addEventListener(type, (e) => seen.push([type, /** @type {CustomEvent} */ (e).detail]));
    for (const value of ['reveal', 'delete']) pick(root, value);
    expect(seen).to.deep.equal([
      ['acp-session-reveal', { sessionId: 's1' }],
      ['acp-session-delete', { sessionId: 's1' }],
    ]);
  });

  it('asks for a new session from its trailing button', async () => {
    const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="T"></acp-session-header>`);
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
      const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="Fix the tree"></acp-session-header>`);
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
      const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="Fix the tree"></acp-session-header>`);
      const events = record(el, 'acp-session-rename');
      const input = await startRename(el);
      input.value = '  TreeView gaps ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await el.updateComplete;
      expect(events.map((e) => e.detail)).to.deep.equal([{ sessionId: 's1', title: 'TreeView gaps' }]);
      expect(root.querySelector('.acp-session-header__rename')).to.equal(null);
    });

    it('saves when the field loses focus', async () => {
      const { el } = await render(html`<acp-session-header session-id="s1" session-title="Fix the tree"></acp-session-header>`);
      const events = record(el, 'acp-session-rename');
      const input = await startRename(el);
      input.value = 'TreeView gaps';
      // Not `blur()`: a test page without window focus gets no focus events.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
      await el.updateComplete;
      expect(events.map((e) => e.detail)).to.deep.equal([{ sessionId: 's1', title: 'TreeView gaps' }]);
    });

    it('keeps the title on Escape, or when it’s left empty or unchanged', async () => {
      const { el } = await render(html`<acp-session-header session-id="s1" session-title="Fix the tree"></acp-session-header>`);
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
      const { el, root } = await render(html`<acp-session-header session-id="s1" session-title="Fix the tree"></acp-session-header>`);
      const input = await startRename(el);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await el.updateComplete;
      expect(root.activeElement).to.equal(root.querySelector('.acp-session-header__title-button'));
    });
  });
});
