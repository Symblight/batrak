import { expect, fixture, html } from '../../../../test/fixture.js';
import '../search-empty.js';

/** @typedef {import('../search-empty.js').AcpSearchEmpty} AcpSearchEmpty */

describe('acp-search-empty', () => {
  it('says what went wrong or was not found, offering a way on only when there is one', async () => {
    const cases = /** @type {{ name: string, props: Partial<AcpSearchEmpty>, contains: string[], lacks: string[], action: string | null, fires: string | null }[]} */ ([
      { name: 'bad regex', props: { error: 'unclosed group', invalidQuery: true, offerPlainText: true }, contains: ['Invalid regular expression', 'unclosed group'], lacks: [], action: 'Search as plain text', fires: 'plain-text' },
      { name: 'bad regex, not a regex search', props: { error: 'unclosed group', invalidQuery: true }, contains: ['Invalid regular expression'], lacks: [], action: null, fires: null },
      { name: 'bad filter', props: { error: 'unclosed class', offerPlainText: true }, contains: ['unclosed class'], lacks: ['Invalid regular expression'], action: null, fires: null },
      { name: 'nothing found', props: { query: 'needle', where: 'in src, *.ts' }, contains: ['No results for needle', 'in src, *.ts'], lacks: [], action: 'Search the whole project', fires: 'whole-project' },
      { name: 'nothing found, no filters', props: { query: 'needle' }, contains: ['No results for needle'], lacks: [], action: null, fires: null },
    ]);
    for (const { name, props, contains, lacks, action, fires } of cases) {
      // Arrange
      const el = /** @type {AcpSearchEmpty} */ (await fixture(html`<acp-search-empty></acp-search-empty>`));
      Object.assign(el, props);
      await el.updateComplete;
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const text = (root.textContent ?? '').replace(/\s+/g, ' ');
      /** @type {CustomEvent[]} */
      const events = [];
      el.addEventListener('acp-search-empty-action', (e) => events.push(/** @type {CustomEvent} */ (e)));
      const button = /** @type {HTMLElement | null} */ (root.querySelector('.acp-search-empty__action'));
      // Act
      button?.click();
      // Assert
      for (const part of contains) expect(text, name).to.contain(part);
      for (const part of lacks) expect(text, name).to.not.contain(part);
      expect(button?.textContent?.trim() ?? null, `${name}: offer`).to.equal(action);
      expect(events.map((e) => e.detail.action), name).to.deep.equal(fires ? [fires] : []);
    }
  });
});
