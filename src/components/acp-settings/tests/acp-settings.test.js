import { expect, fixture, html } from '../../../../test/fixture.js';
import { DEFAULT_SETTINGS } from '../../../models/settings.js';
import '../acp-settings.js';

/** @typedef {import('../acp-settings.js').AcpSettings} AcpSettings */

/** A short tab, so the sections scroll. */
async function render() {
  const el = /** @type {AcpSettings} */ (
    await fixture(
      html`<acp-settings style="height: 320px" .settings=${DEFAULT_SETTINGS} .fonts=${[]}></acp-settings>`,
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
});
