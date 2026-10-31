import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../bytes.js';

/** @param {Element} el */
const valueOf = (el) => el.querySelector('.acp-bytes__value');
/** @param {Element} el */
const text = (el) => valueOf(el)?.textContent?.trim() ?? '';

describe('acp-bytes', () => {
  it('formats the count from bytes up to gigabytes, with the exact count as a tooltip, and nothing for a missing value', async () => {
    const cases = [
      [512, '512.0 B', '512 bytes'],
      [1536, '1.5 KB', '1,536 bytes'],
      [5 * 1024 ** 2, '5.0 MB', '5,242,880 bytes'],
      [2048 * 1024 ** 3, '2048.0 GB', '2,199,023,255,552 bytes'],
      [undefined, '', null],
      [NaN, '', null],
    ];
    for (const [value, shown, tip] of cases) {
      const el = await fixture(html`<acp-bytes .value=${value}></acp-bytes>`);
      expect(text(el), String(value)).to.equal(shown);
      if (tip) expect(tooltipOf(valueOf(el)), `${value} tooltip`).to.equal(tip);
      expect(el.querySelector('[title]'), 'no title attribute').to.equal(null);
    }
  });

  it('renders into itself, and gives each count its own tooltip anchor when several share a root', async () => {
    const box = await fixture(html`<div><acp-bytes .value=${1536}></acp-bytes><acp-bytes .value=${2048}></acp-bytes></div>`);
    const [a, b] = [...box.querySelectorAll('acp-bytes')];
    expect(a.shadowRoot === null, 'no shadow root').to.equal(true);
    expect([a, b].map((el) => tooltipOf(valueOf(el)))).to.deep.equal(['1,536 bytes', '2,048 bytes']);
  });
});
