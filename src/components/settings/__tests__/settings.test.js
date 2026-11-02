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
    expect(items.map((i) => i.textContent?.trim())).to.deep.equal(['Theme', 'Editor']);
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
    expect(items.map(tooltipOf)).to.deep.equal(['Theme', 'Editor']);
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
});
