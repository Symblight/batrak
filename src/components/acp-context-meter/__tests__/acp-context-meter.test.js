import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-context-meter.js';

/** @typedef {import('../acp-context-meter.js').AcpContextMeter} AcpContextMeter */

/** @param {import('../../../models/types/types.js').ContextUsage | null} usage */
async function render(usage) {
  const el = /** @type {AcpContextMeter} */ (await fixture(html`<acp-context-meter .usage=${usage}></acp-context-meter>`));
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  const ring = /** @type {HTMLElement & { value: number | undefined }} */ (root.querySelector('md-progress-circular'));
  const tooltip = root.querySelector('md-tooltip')?.textContent?.replace(/\s+/g, ' ').trim();
  const percent = root.querySelector('.acp-context-meter__percent')?.textContent?.trim();
  return { el, root, ring, tooltip, percent };
}

describe('acp-context-meter', () => {
  it('shows only the empty ring before the agent reports anything, and says so', async () => {
    const { root, ring, tooltip, percent } = await render(null);
    expect(ring, 'always there').to.not.equal(null);
    expect(ring.value, 'empty, not spinning').to.equal(0);
    expect(percent, 'no percentage').to.equal(undefined);
    expect(tooltip).to.equal('Context usage: not reported yet');
    expect(root.querySelector('.acp-context-meter__popover')?.textContent).to.contain('reports it with its replies');
  });

  it('shows how full the context is, with the tokens in its tooltip', async () => {
    const { ring, tooltip, percent } = await render({ used: 24_000, size: 200_000 });
    expect(ring.value).to.equal(0.12);
    expect(percent, 'the ring only; the tooltip says how much').to.equal(undefined);
    expect(tooltip).to.equal('Context: 12% used (24k of 200k tokens)');
  });

  it('never shows the session cost', async () => {
    const usage = /** @type {import('../../../models/types/types.js').ContextUsage} */ ({ used: 1000, size: 200000, cost: { amount: 0.04, currency: 'USD' } });
    const { root } = await render(usage);
    expect(root.querySelector('.acp-context-meter__popover')?.textContent).to.not.match(/cost|\$0\.04|US\$/i);
  });
});
