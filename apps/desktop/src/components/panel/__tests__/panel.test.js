import { expect, fixture, html } from '../../../../test/fixture.js';
import '../panel.js';

/** @typedef {import('../panel.js').AcpPanel} AcpPanel */

describe('acp-panel', () => {
  it('takes a header and its other children into separate slots', async () => {
    const el = /** @type {AcpPanel} */ (
      await fixture(html`<acp-panel><div slot="header" id="head"></div><div id="body"></div></acp-panel>`)
    );
    const assigned = (/** @type {string} */ selector) =>
      /** @type {HTMLSlotElement} */ (el.shadowRoot?.querySelector(selector)).assignedElements().map((e) => e.id);
    expect(assigned('slot[name="header"]')).to.deep.equal(['head']);
    expect(assigned('slot:not([name])')).to.deep.equal(['body']);
  });

  it('shows a labelled spinner only while loading', async () => {
    const el = /** @type {AcpPanel} */ (await fixture(html`<acp-panel loading-label="Opening project"></acp-panel>`));
    expect(el.shadowRoot?.querySelector('md-progress-circular')).to.equal(null);
    el.loading = true;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('md-progress-circular')?.getAttribute('aria-label')).to.equal('Opening project');
  });

  it('is a column unless it is the window', async () => {
    const el = /** @type {AcpPanel} */ (await fixture(html`<acp-panel></acp-panel>`));
    expect(el.variant).to.equal('column');
    expect((await fixture(html`<acp-panel variant="window"></acp-panel>`)).getAttribute('variant')).to.equal('window');
  });
});
