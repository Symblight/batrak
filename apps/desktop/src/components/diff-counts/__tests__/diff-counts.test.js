import { expect, fixture, html } from '../../../../test/fixture.js';
import '../diff-counts.js';

describe('acp-diff-counts', () => {
  it('shows what a change adds and removes, and nothing without counts', async () => {
    /** @type {[number | null, number | null, string][]} */
    const cases = [
      [12, 3, '+12 −3'],
      [12, 0, '+12'],
      [0, 3, '−3'],
      [null, 3, '−3'],
      [0, 0, ''],
      [null, null, ''],
    ];
    for (const [added, removed, text] of cases) {
      const el = await fixture(html`<acp-diff-counts .added=${added} .removed=${removed}></acp-diff-counts>`);
      const shown = (el.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
      expect(shown, `${added}/${removed}`).to.equal(text);
      expect(/** @type {HTMLElement} */ (el).hidden, `${added}/${removed}: no counts, no box`).to.equal(text === '');
    }
  });
});
