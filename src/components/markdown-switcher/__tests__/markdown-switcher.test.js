import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import { shortcuts } from '../../../hooks/shortcuts/shortcuts.js';
import '../markdown-switcher.js';

/** @typedef {import('../markdown-switcher.js').AcpMarkdownSwitcher} AcpMarkdownSwitcher */

/** @param {AcpMarkdownSwitcher} el */
const segments = (el) => [.../** @type {ShadowRoot} */ (el.shadowRoot).querySelectorAll('.acp-markdown-switcher__segment:not(.acp-markdown-switcher__sync)')];

/**
 * @param {AcpMarkdownSwitcher} el
 * @param {string} type
 */
function listen(el, type) {
  /** @type {unknown[]} */
  const heard = [];
  el.addEventListener(type, (e) => heard.push(/** @type {CustomEvent} */ (e).detail));
  return heard;
}

describe('acp-markdown-switcher', () => {
  it('is a group of three buttons, the current view pressed', async () => {
    const el = await fixture(html`<acp-markdown-switcher mode="split"></acp-markdown-switcher>`);

    expect(el.shadowRoot.querySelector('[role=group]')?.getAttribute('aria-label')).to.equal('Markdown view');
    expect(segments(el).map((s) => [s.getAttribute('aria-label'), s.getAttribute('aria-pressed')])).to.deep.equal([
      ['Raw', 'false'],
      ['Split', 'true'],
      ['Preview', 'false'],
    ]);

    el.mode = 'preview';
    await el.updateComplete;
    expect(segments(el).map((s) => s.getAttribute('aria-pressed'))).to.deep.equal(['false', 'false', 'true']);
  });

  it('asks for the view that was pressed, and for none when it is already shown', async () => {
    const el = await fixture(html`<acp-markdown-switcher mode="raw"></acp-markdown-switcher>`);
    const heard = listen(el, 'acp-markdown-mode');

    /** @type {HTMLElement} */ (segments(el)[1]).click();
    /** @type {HTMLElement} */ (segments(el)[2]).click();
    /** @type {HTMLElement} */ (segments(el)[0]).click();

    expect(heard).to.deep.equal([{ mode: 'split' }, { mode: 'preview' }]);
  });

  it('hints each view with its label and shortcut', async () => {
    const el = await fixture(html`<acp-markdown-switcher mode="raw"></acp-markdown-switcher>`);

    expect(segments(el).map(tooltipOf)).to.deep.equal([
      'Raw',
      `Split (${shortcuts.hint('markdownSplit')})`,
      `Preview (${shortcuts.hint('markdownPreview')})`,
    ]);
    expect(el.shadowRoot.querySelector('[title]')).to.equal(null);
  });

  describe('the scroll sync toggle', () => {
    it('shows in Split only', async () => {
      const el = await fixture(html`<acp-markdown-switcher mode="raw"></acp-markdown-switcher>`);
      const toggle = () => el.shadowRoot.querySelector('.acp-markdown-switcher__sync');

      expect(toggle()).to.equal(null);
      for (const mode of ['preview', 'split']) {
        el.mode = mode;
        await el.updateComplete;
        expect(toggle() !== null, mode).to.equal(mode === 'split');
      }
    });

    it('shows whether the panes scroll together, and flips it when pressed', async () => {
      const el = await fixture(html`<acp-markdown-switcher mode="split" .scrollSync=${true}></acp-markdown-switcher>`);
      const heard = listen(el, 'acp-markdown-sync');
      const toggle = () => /** @type {HTMLElement} */ (el.shadowRoot.querySelector('.acp-markdown-switcher__sync'));

      expect(toggle().getAttribute('aria-pressed')).to.equal('true');
      expect(tooltipOf(toggle())).to.equal('Scroll together');

      toggle().click();
      el.scrollSync = false;
      await el.updateComplete;
      expect(toggle().getAttribute('aria-pressed')).to.equal('false');
      toggle().click();

      expect(heard).to.deep.equal([{ on: false }, { on: true }]);
    });
  });
});
