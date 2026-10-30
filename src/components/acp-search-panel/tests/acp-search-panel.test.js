import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-search-panel.js';

describe('acp-search-panel', () => {
  it("names each option and each result's path in tooltips, not titles", async () => {
    const results = [{ path: 'src/main.js', matches: [{ line: 3, text: 'const a = 1;', ranges: [[6, 7]] }] }];
    const el = await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const options = [...root.querySelectorAll('.acp-search-panel__option')].map(tooltipOf);
    expect(options).to.deep.equal(['Match case', 'Match whole word', 'Use regular expression']);
    expect(tooltipOf(root.querySelector('.acp-search-panel__file-header'))).to.equal('src/main.js');
    expect(root.querySelector('[title]')).to.equal(null);
  });
});
