import { settings as settingsHook } from '../../../hooks/settings/settings.js';
import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../settings.js';

/** @typedef {import('../settings.js').AcpSettings} AcpSettings */

/** A short tab, so the sections scroll. */
async function render() {
  const el = /** @type {AcpSettings} */ (
    await fixture(
      html`<acp-settings style="height: 320px" .settings=${settingsHook.defaults} .fonts=${[]}></acp-settings>`,
    )
  );
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** @param {ShadowRoot} root */
function current(root) {
  return root.querySelector('.acp-settings__nav-item[aria-current="true"]')?.textContent?.trim();
}

/**
 * The scroller, scrolling at once: a background test page gets no frames, which smooth scrolling and
 * `scroll` events wait for. `scroll` is fired after each scroll instead.
 * @param {ShadowRoot} root
 */
function scrollerOf(root) {
  const scroller = /** @type {HTMLElement} */ (root.querySelector('.acp-settings__scroller'));
  const original = /** @type {(options: ScrollToOptions) => void} */ (scroller.scrollTo.bind(scroller));
  /** @param {ScrollToOptions} options */
  const scrollTo = (options) => {
    original({ ...options, behavior: 'instant' });
    scroller.dispatchEvent(new Event('scroll'));
  };
  scroller.scrollTo = /** @type {HTMLElement['scrollTo']} */ (scrollTo);
  return scroller;
}

/** @param {AcpSettings} el */
const rendered = (el) => el.updateComplete;

describe('acp-settings', () => {
  it('names the bundled font the editor uses by default', async () => {
    const { root } = await render();
    const option = /** @type {HTMLElement} */ (root.querySelector('.acp-settings__input_font md-option[value=""]'));
    expect(option.textContent?.trim()).to.equal('Google Sans Code (default)');
  });

  it('lists its sections and follows the scroll', async () => {
    const { el, root } = await render();
    const items = [...root.querySelectorAll('.acp-settings__nav-item')];
    expect(items.map((i) => i.textContent?.trim())).to.deep.equal(['Theme', 'Editor', 'Terminal']);
    expect(current(root)).to.equal('Theme');

    const scroller = scrollerOf(root);
    /** @type {HTMLElement} */ (items[1]).click();
    await rendered(el);
    expect(scroller.scrollTop).to.be.greaterThan(0);
    expect(current(root)).to.equal('Editor');

    scroller.scrollTo({ top: 0 });
    await rendered(el);
    expect(current(root)).to.equal('Theme');
  });

  it('explains its controls in tooltips, not titles', async () => {
    const { root } = await render();
    const items = [...root.querySelectorAll('.acp-settings__nav-item')];
    expect(items.map(tooltipOf)).to.deep.equal(['Theme', 'Editor', 'Terminal']);
    expect(tooltipOf(root.querySelector('.acp-settings__icon-button'))).to.equal('Pick a color');
    expect(tooltipOf(root.querySelector('.acp-settings__link'))).to.equal('Not available yet');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it('scrolls to a section when asked, then says so', async () => {
    const { el, root } = await render();
    const scroller = scrollerOf(root);
    /** @type {unknown[]} */
    const revealed = [];
    el.addEventListener('acp-settings-revealed', (e) => revealed.push(/** @type {CustomEvent} */ (e).detail.reveal));
    const reveal = { section: /** @type {const} */ ('editor') };
    el.reveal = reveal;
    await el.updateComplete;
    expect(revealed).to.deep.equal([reveal]);
    await rendered(el);
    expect(scroller.scrollTop).to.be.greaterThan(0);
    expect(current(root)).to.equal('Editor');
  });

  it('leaves the agents to their own tab', async () => {
    const { root } = await render();
    expect(root.querySelector('[data-section="agents"]') !== null, 'no Agents section').to.equal(false);
    expect([...root.querySelectorAll('md-button')].some((b) => b.textContent?.includes('Edit agents.json'))).to.equal(false);
  });

  describe('markdown', () => {
    /** @param {ShadowRoot} root */
    const toggle = (root) => /** @type {HTMLElementTagNameMap['md-switch']} */ (root.querySelector('.acp-settings__switch_markdown-sync'));

    /** @param {AcpSettings} el */
    function changes(el) {
      /** @type {unknown[]} */
      const patches = [];
      el.addEventListener('acp-settings-change', (e) => patches.push(/** @type {CustomEvent} */ (e).detail.patch));
      return patches;
    }

    it('shows whether the editor and preview scroll together, and asks to flip it', async () => {
      const { el, root } = await render();
      const patches = changes(el);
      expect(toggle(root).selected).to.equal(true);

      toggle(root).selected = false;
      toggle(root).dispatchEvent(new Event('change', { bubbles: true }));
      el.settings = { ...settingsHook.defaults, markdownScrollSync: false };
      await el.updateComplete;

      expect(patches).to.deep.equal([{ markdownScrollSync: false }]);
      expect(toggle(root).selected).to.equal(false);
    });

    it('is reset with the rest of the Editor section', async () => {
      const { el, root } = await render();
      el.settings = { ...settingsHook.defaults, markdownScrollSync: false };
      await el.updateComplete;
      /** @type {unknown[]} */
      const resets = [];
      el.addEventListener('acp-settings-reset', (e) => resets.push(/** @type {CustomEvent} */ (e).detail));

      /** @type {HTMLElement} */ (root.querySelector('[data-section="editor"] .acp-settings__header-button')).click();

      expect(resets).to.deep.equal([{ section: 'editor' }]);
    });
  });

  describe('the terminal section', () => {
    const section = (/** @type {ShadowRoot} */ root) => /** @type {HTMLElement} */ (root.querySelector('[data-section="terminal"]'));
    const sizeField = (/** @type {ShadowRoot} */ root) => /** @type {HTMLElementTagNameMap['md-text-field']} */ (section(root).querySelector('md-text-field'));

    /** @param {AcpSettings} el */
    function changes(el) {
      /** @type {unknown[]} */
      const patches = [];
      el.addEventListener('acp-settings-change', (e) => patches.push(/** @type {CustomEvent} */ (e).detail.patch));
      return patches;
    }

    it('offers only monospaced fonts, or the editor’s, and asks for what is picked', async () => {
      // Arrange
      const { el, root } = await render();
      el.fonts = [{ family: 'Fira Code', monospace: true }, { family: 'Arial', monospace: false }];
      await rendered(el);
      const patches = changes(el);
      const select = /** @type {HTMLElementTagNameMap['md-select']} */ (section(root).querySelector('md-select'));
      // Assert
      expect([...select.querySelectorAll('md-option')].map((o) => o.textContent?.trim())).to.deep.equal(['Same as the editor', 'Fira Code']);
      // Act
      select.value = 'Fira Code';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      // Assert
      expect(patches).to.deep.equal([{ terminalFont: 'Fira Code' }, { terminalFont: null }]);
    });

    it('takes a size typed, a size stepped from the editor’s, and goes back to the editor’s when emptied', async () => {
      // Arrange
      const { el, root } = await render();
      el.settings = { ...settingsHook.defaults, editorFontSize: 14 };
      await rendered(el);
      const patches = changes(el);
      const field = sizeField(root);
      const type = (/** @type {string} */ value) => {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      };
      // Assert
      expect(field.value, 'empty while it is the editor’s').to.equal('');
      expect(section(root).textContent, 'says whose').to.include('14 px');
      // Act
      /** @type {HTMLElement} */ (section(root).querySelector('[aria-label="Larger"]')).click();
      type('16');
      type('3');
      type('');
      // Assert
      expect(patches, 'a size out of bounds is not asked for').to.deep.equal([{ terminalFontSize: 15 }, { terminalFontSize: 16 }, { terminalFontSize: null }]);
    });

    it('resets on its own, once something is set', async () => {
      // Arrange
      const { el, root } = await render();
      const reset = () => /** @type {HTMLElementTagNameMap['md-button']} */ (section(root).querySelector('.acp-settings__header-button'));
      /** @type {unknown[]} */
      const resets = [];
      el.addEventListener('acp-settings-reset', (e) => resets.push(/** @type {CustomEvent} */ (e).detail));
      expect(reset().disabled, 'nothing to reset').to.equal(true);
      el.settings = { ...settingsHook.defaults, terminalFontSize: 15 };
      await rendered(el);
      // Act
      reset().click();
      // Assert
      expect(resets).to.deep.equal([{ section: 'terminal' }]);
    });
  });
});
