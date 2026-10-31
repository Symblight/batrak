import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-bytes.js';

/** @param {Element} el */
const text = (el) => el.shadowRoot?.querySelector('.acp-bytes__value')?.textContent?.trim() ?? '';

describe('acp-bytes', () => {
  it('shows the byte count formatted', async () => {
    const el = await fixture(html`<acp-bytes .value=${1536}></acp-bytes>`);
    expect(text(el)).to.equal('1.5 KB');
  });

  it('keeps value a Number, also from the attribute', async () => {
    const el = await fixture(html`<acp-bytes value="2048"></acp-bytes>`);
    expect(el.value).to.equal(2048);
    expect(text(el)).to.equal('2.0 KB');
  });

  it('updates when value changes', async () => {
    const el = await fixture(html`<acp-bytes .value=${1}></acp-bytes>`);
    el.value = 5 * 1024 ** 2;
    await el.updateComplete;
    expect(text(el)).to.equal('5.0 MB');
  });

  it('shows nothing for a missing or non-finite value', async () => {
    const el = await fixture(html`<acp-bytes></acp-bytes>`);
    expect(text(el)).to.equal('');
    el.value = NaN;
    await el.updateComplete;
    expect(text(el)).to.equal('');
  });

  it('exposes the exact count as a tooltip', async () => {
    const el = await fixture(html`<acp-bytes .value=${1536}></acp-bytes>`);
    expect(tooltipOf(el.shadowRoot?.querySelector('.acp-bytes__value'))).to.equal('1,536 bytes');
    expect(el.shadowRoot?.querySelector('[title]')).to.equal(null);
  });
});
