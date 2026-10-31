import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../bytes.js';

/** @param {Element} el */
const text = (el) => el.querySelector('.acp-bytes__value')?.textContent?.trim() ?? '';

describe('acp-bytes', () => {
  it('shows the byte count formatted', async () => {
    const el = await fixture(html`<acp-bytes .value=${1536}></acp-bytes>`);
    expect(text(el)).to.equal('1.5 KB');
  });

  it('counts bytes under a kilobyte and stops at gigabytes', async () => {
    const el = await fixture(html`<acp-bytes .value=${512}></acp-bytes>`);
    expect(text(el)).to.equal('512.0 B');
    el.value = 2048 * 1024 ** 3;
    await el.updateComplete;
    expect(text(el)).to.equal('2048.0 GB');
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
    expect(tooltipOf(el.querySelector('.acp-bytes__value'))).to.equal('1,536 bytes');
    expect(el.querySelector('[title]') === null).to.equal(true);
  });

  it('renders into itself, and gives each count its own tooltip anchor when several share a root', async () => {
    const box = await fixture(html`<div><acp-bytes .value=${1536}></acp-bytes><acp-bytes .value=${2048}></acp-bytes></div>`);
    const [a, b] = [...box.querySelectorAll('acp-bytes')];
    expect(a.shadowRoot === null, 'no shadow root').to.equal(true);
    expect([a, b].map((el) => tooltipOf(el.querySelector('.acp-bytes__value')))).to.deep.equal(['1,536 bytes', '2,048 bytes']);
  });
});
