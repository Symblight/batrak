import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../changes-panel.js';

describe('acp-changes-panel', () => {
  it('names Refresh in a tooltip, not a title', async () => {
    const el = await fixture(html`<acp-changes-panel></acp-changes-panel>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('.acp-changes-panel__refresh'))).to.equal('Refresh');
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
