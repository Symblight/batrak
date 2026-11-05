import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../search-bar.js';

/** @typedef {import('../search-bar.js').AcpSearchBar} AcpSearchBar */

describe('acp-search-bar', () => {
  /** @param {AcpSearchBar} el */
  const input = (el) => /** @type {HTMLInputElement} */ (el.shadowRoot?.querySelector('input'));

  it('shows the query and the options, marks a bad query, and fires typing, clear and option toggles', async () => {
    // Arrange
    const el = /** @type {AcpSearchBar} */ (await fixture(html`<acp-search-bar query="foo" expanded regex></acp-search-bar>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {CustomEvent[]} */
    const events = [];
    for (const type of ['acp-search-bar-input', 'acp-search-bar-clear', 'acp-search-option-toggle']) el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
    const state = [input(el).value, input(el).getAttribute('aria-expanded'), input(el).getAttribute('aria-invalid'), input(el).getAttribute('role')];
    const clear = /** @type {HTMLElement} */ (root.querySelector('.acp-search-bar__clear'));
    const hint = tooltipOf(clear);
    // Act
    input(el).value = 'foobar';
    input(el).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    clear.click();
    /** @type {HTMLElement} */ (root.querySelector('acp-search-options')?.shadowRoot?.querySelector('.acp-search-options__option')).click();
    el.invalid = true;
    el.query = '';
    await el.updateComplete;
    // Assert
    expect(state).to.deep.equal(['foo', 'true', 'false', 'combobox']);
    expect(hint).to.equal('Clear');
    expect(events.map((e) => [e.type, e.detail])).to.deep.equal([
      ['acp-search-bar-input', { value: 'foobar' }],
      ['acp-search-bar-clear', null],
      ['acp-search-option-toggle', { option: 'caseSensitive' }],
    ]);
    expect(root.querySelector('acp-search-options')?.regex, 'options follow the host').to.equal(true);
    expect(input(el).getAttribute('aria-invalid')).to.equal('true');
    expect(el.hasAttribute('invalid')).to.equal(true);
    expect(root.querySelector('.acp-search-bar__clear'), 'no clear for an empty query').to.equal(null);
  });

  it('focuses its field, selecting the text when asked', async () => {
    const el = /** @type {AcpSearchBar} */ (await fixture(html`<acp-search-bar query="hello"></acp-search-bar>`));
    el.focusInput({ select: true });
    expect(el.shadowRoot?.activeElement === input(el)).to.equal(true);
    expect([input(el).selectionStart, input(el).selectionEnd]).to.deep.equal([0, 5]);
  });
});
