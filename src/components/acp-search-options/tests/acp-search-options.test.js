import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-search-options.js';

/** @typedef {import('../acp-search-options.js').AcpSearchOptions} AcpSearchOptions */

describe('acp-search-options', () => {
  /** @param {AcpSearchOptions} el */
  const buttons = (el) => /** @type {HTMLElement[]} */ ([...(/** @type {ShadowRoot} */ (el.shadowRoot)).querySelectorAll('.acp-search-options__option')]);

  it('names each toggle with its Alt shortcut in a tooltip, not a title', async () => {
    const el = /** @type {AcpSearchOptions} */ (await fixture(html`<acp-search-options></acp-search-options>`));
    expect(buttons(el).map(tooltipOf)).to.deep.equal([
      'Match case (Alt+C)',
      'Match whole word (Alt+W)',
      'Use regular expression (Alt+R)',
    ]);
    expect(el.shadowRoot?.querySelector('[title]')).to.equal(null);
  });

  it('shows each option as selected or not', async () => {
    const el = /** @type {AcpSearchOptions} */ (
      await fixture(html`<acp-search-options .caseSensitive=${true} .regex=${true}></acp-search-options>`)
    );
    expect(buttons(el).map((b) => b.hasAttribute('selected'))).to.deep.equal([true, false, true]);
    expect(buttons(el).map((b) => b.getAttribute('aria-pressed'))).to.deep.equal(['true', 'false', 'true']);
  });

  it('fires the option to toggle, leaving its own state to the host', async () => {
    const el = /** @type {AcpSearchOptions} */ (await fixture(html`<acp-search-options></acp-search-options>`));
    /** @type {CustomEvent[]} */
    const events = [];
    el.addEventListener('acp-search-option-toggle', (e) => events.push(/** @type {CustomEvent} */ (e)));
    for (const button of buttons(el)) button.click();
    expect(events.map((e) => e.detail)).to.deep.equal([{ option: 'caseSensitive' }, { option: 'wholeWord' }, { option: 'regex' }]);
    expect(events[0].bubbles && events[0].composed).to.equal(true);
    await el.updateComplete;
    expect(buttons(el).some((b) => b.hasAttribute('selected'))).to.equal(false);
  });
});
