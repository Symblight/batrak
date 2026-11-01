import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../search-view-picker.js';

/** @typedef {import('../search-view-picker.js').AcpSearchViewPicker} AcpSearchViewPicker */

describe('acp-search-view-picker', () => {
  it('shows the current view as checked with tooltips, and fires only the other one', async () => {
    // Arrange
    const el = /** @type {AcpSearchViewPicker} */ (await fixture(html`<acp-search-view-picker view="grouped"></acp-search-view-picker>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const buttons = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.acp-search-view-picker__button')]);
    /** @type {CustomEvent[]} */
    const events = [];
    el.addEventListener('acp-search-view-pick', (e) => events.push(/** @type {CustomEvent} */ (e)));
    // Act
    buttons[0].click();
    buttons[1].click();
    el.view = 'flat';
    await el.updateComplete;
    // Assert
    expect(buttons.map(tooltipOf)).to.deep.equal(['Group by file', 'Flat list']);
    expect(root.querySelectorAll('[role="radio"]'), 'two radios').to.have.length(2);
    expect(root.querySelector('[title]'), 'tooltips, not titles').to.equal(null);
    expect(events.map((e) => e.detail), 'the current view asks for nothing').to.deep.equal([{ view: 'flat' }]);
    expect(events[0].bubbles && events[0].composed).to.equal(true);
    expect(buttons.map((b) => b.getAttribute('aria-checked'))).to.deep.equal(['false', 'true']);
  });
});
