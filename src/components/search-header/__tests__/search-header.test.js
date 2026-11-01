import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../search-header.js';

/** @typedef {import('../search-header.js').AcpSearchHeader} AcpSearchHeader */

describe('acp-search-header', () => {
  it('names its buttons in tooltips with an icon each, marks the current preview, and fires what was pressed', async () => {
    // Arrange
    const el = /** @type {AcpSearchHeader} */ (await fixture(html`<acp-search-header preview-position="right"></acp-search-header>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const buttons = /** @type {(HTMLElement & { updateComplete: Promise<unknown> })[]} */ ([...root.querySelectorAll('.acp-search-header__button')]);
    /** @type {CustomEvent[]} */
    const events = [];
    for (const type of ['acp-search-header-preview', 'acp-search-header-popout']) el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
    // Act
    for (const button of buttons) await button.updateComplete;
    for (const button of buttons) button.click();
    // Assert
    expect(root.querySelector('.acp-search-header__title')?.textContent).to.equal('Search in files');
    expect(buttons.map(tooltipOf)).to.deep.equal(['Preview below', 'Preview on the right', 'Open in panel']);
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).to.deep.equal(['false', 'true', null]);
    for (const button of buttons) {
      const slot = button.shadowRoot?.querySelector('slot');
      expect(slot?.assignedElements().map((i) => i.localName), button.getAttribute('aria-label') ?? '').to.deep.equal(['md-icon']);
    }
    expect(events.map((e) => [e.type, e.detail])).to.deep.equal([
      ['acp-search-header-preview', { position: 'bottom' }],
      ['acp-search-header-preview', { position: 'right' }],
      ['acp-search-header-popout', null],
    ]);
    expect(events.every((e) => e.bubbles && e.composed)).to.equal(true);
  });
});
