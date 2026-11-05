import { expect, fixture, html } from '../../../../test/fixture.js';
import '../search-recent.js';

/** @typedef {import('../search-recent.js').AcpSearchRecent} AcpSearchRecent */

describe('acp-search-recent', () => {
  it('lists the queries with the selected one marked, and fires the one clicked', async () => {
    // Arrange
    const el = /** @type {AcpSearchRecent} */ (await fixture(html`<acp-search-recent .queries=${['alpha', 'beta']} .index=${1}></acp-search-recent>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const items = () => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.acp-search-recent__item')]);
    /** @type {CustomEvent[]} */
    const picks = [];
    el.addEventListener('acp-search-recent-pick', (e) => picks.push(/** @type {CustomEvent} */ (e)));
    // Act
    items()[0].click();
    // Assert
    expect(root.querySelector('.acp-search-recent__heading')?.textContent).to.equal('Recent searches');
    expect(items().map((i) => i.textContent?.trim())).to.deep.equal(['alpha', 'beta']);
    expect(items().map((i) => i.getAttribute('aria-selected'))).to.deep.equal(['false', 'true']);
    expect(root.querySelector('[role="listbox"]')?.getAttribute('aria-label')).to.equal('Recent searches');
    expect(picks.map((e) => e.detail)).to.deep.equal([{ query: 'alpha' }]);
    expect(picks[0].bubbles && picks[0].composed).to.equal(true);
  });
});
