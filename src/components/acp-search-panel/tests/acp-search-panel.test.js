import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-search-panel.js';

describe('acp-search-panel', () => {
  it("names each option and each result's path in tooltips, not titles", async () => {
    const results = [{ path: 'src/main.js', matches: [{ line: 3, text: 'const a = 1;', offset: 0, ranges: [[6, 7]] }] }];
    const el = await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const options = [...root.querySelectorAll('.acp-search-panel__option')].map(tooltipOf);
    expect(options).to.deep.equal(['Match case', 'Match whole word', 'Use regular expression']);
    expect(tooltipOf(root.querySelector('.acp-search-panel__file-header'))).to.equal('src/main.js');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  /** @param {HTMLElement} el */
  const shadow = (el) => /** @type {ShadowRoot} */ (el.shadowRoot);

  /**
   * @param {HTMLElement} el
   * @param {string} type
   */
  const nextEvent = (el, type) =>
    new Promise((resolve) => el.addEventListener(type, (e) => resolve(e), { once: true }));

  /** @param {HTMLElement} el */
  const summaryText = (el) =>
    (shadow(el).querySelector('.acp-search-panel__summary')?.textContent ?? '').replace(/\s+/g, ' ').trim();

  /**
   * Types into the md-text-field like a user would.
   * @param {Element} field
   * @param {string} value
   */
  const type = (field, value) => {
    /** @type {HTMLElementTagNameMap['md-text-field']} */ (field).value = value;
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  };

  const results = [
    {
      path: 'src/a/main.js',
      matches: [
        { line: 3, text: 'const foo = foo;', offset: 0, ranges: /** @type {[number, number][]} */ ([[6, 9], [12, 15]]) },
        { line: 10, text: 'foo()', offset: 0, ranges: /** @type {[number, number][]} */ ([[0, 3]]) },
      ],
    },
    { path: 'README.md', matches: [{ line: 1, text: 'a foo', offset: 0, ranges: /** @type {[number, number][]} */ ([[2, 5]]) }] },
  ];

  it('renders results grouped by file with name, folder, count and highlighted match rows', async () => {
    const el = await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`);
    const root = shadow(el);
    const headers = [...root.querySelectorAll('.acp-search-panel__file-header')];
    expect(headers.map((h) => [
      h.querySelector('.acp-search-panel__file-name')?.textContent,
      h.querySelector('.acp-search-panel__file-dir')?.textContent,
      h.querySelector('.acp-search-panel__count')?.textContent,
    ])).to.deep.equal([['main.js', 'src/a', '3'], ['README.md', '', '1']]);
    const rows = [...root.querySelectorAll('.acp-search-panel__match')];
    expect(rows.map((r) => r.querySelector('.acp-search-panel__line')?.textContent)).to.deep.equal(['3', '10', '1']);
    expect([...rows[0].querySelectorAll('mark.acp-search-panel__hit')].map((m) => m.textContent)).to.deep.equal(['foo', 'foo']);
    expect(rows[0].querySelector('.acp-search-panel__text')?.textContent).to.equal('const foo = foo;');
  });

  it('collapses and expands a file group, and resets collapsed groups when results empty', async () => {
    const el = /** @type {import('../acp-search-panel.js').AcpSearchPanel} */ (
      await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`)
    );
    const root = shadow(el);
    const header = /** @type {HTMLButtonElement} */ (root.querySelector('.acp-search-panel__file-header'));
    header.click();
    await el.updateComplete;
    expect(header.getAttribute('aria-expanded')).to.equal('false');
    expect(root.querySelectorAll('.acp-search-panel__match').length).to.equal(1);
    header.click();
    await el.updateComplete;
    expect(header.getAttribute('aria-expanded')).to.equal('true');
    expect(root.querySelectorAll('.acp-search-panel__match').length).to.equal(3);

    header.click();
    await el.updateComplete;
    el.results = [];
    await el.updateComplete;
    el.results = results;
    await el.updateComplete;
    expect(root.querySelector('.acp-search-panel__file-header')?.getAttribute('aria-expanded')).to.equal('true');
    expect(root.querySelectorAll('.acp-search-panel__match').length).to.equal(3);
  });

  it('opens a clicked match at its line under the root', async () => {
    const el = await fixture(html`<acp-search-panel .root=${'/proj'} .results=${results}></acp-search-panel>`);
    const match = /** @type {HTMLButtonElement} */ (shadow(el).querySelectorAll('.acp-search-panel__match')[1]);
    const event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-file-open'));
    match.click();
    const e = await event;
    expect(e.detail).to.deep.equal({ path: '/proj/src/a/main.js', line: 10 });
    expect(e.bubbles).to.equal(true);
    expect(e.composed).to.equal(true);
  });

  it('summarizes the search: searching, no results, counts, the limit and errors', async () => {
    const el = /** @type {import('../acp-search-panel.js').AcpSearchPanel} */ (
      await fixture(html`<acp-search-panel searching .results=${results}></acp-search-panel>`)
    );
    expect(shadow(el).querySelector('.acp-search-panel__summary')).to.equal(null);
    el.query = 'foo';
    await el.updateComplete;
    expect(summaryText(el)).to.equal('Searching… 4 results in 2 files');
    el.searching = false;
    await el.updateComplete;
    expect(summaryText(el)).to.equal('4 results in 2 files');
    el.limitHit = true;
    await el.updateComplete;
    expect(summaryText(el)).to.equal('4 results in 2 files — showing the first 2000');
    el.limitHit = false;
    el.results = [];
    await el.updateComplete;
    expect(summaryText(el)).to.equal('No results');
    el.error = 'bad regex';
    await el.updateComplete;
    const summary = shadow(el).querySelector('.acp-search-panel__summary');
    expect(summary?.classList.contains('acp-search-panel__summary_error')).to.equal(true);
    expect(summaryText(el)).to.equal('bad regex');
  });

  it('searches at once when an option is toggled', async () => {
    const el = await fixture(html`<acp-search-panel></acp-search-panel>`);
    const buttons = /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-panel__option')]);
    for (const [i, option] of /** @type {const} */ (['caseSensitive', 'wholeWord', 'regex']).entries()) {
      const event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
      buttons[i].click();
      const { detail } = await event;
      expect(detail.delay).to.equal(0);
      expect(detail.options[option]).to.equal(true);
    }
  });

  it('searches after a pause when typing and at once on Enter', async () => {
    const el = await fixture(html`<acp-search-panel></acp-search-panel>`);
    const fields = [...shadow(el).querySelectorAll('md-text-field')];
    let event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
    type(fields[0], 'foo');
    let { detail } = await event;
    expect(detail).to.deep.equal({
      delay: 250,
      options: { query: 'foo', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' },
    });
    event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
    type(fields[1], 'src');
    ({ detail } = await event);
    expect(detail.delay).to.equal(250);
    expect(detail.options.include).to.equal('src');
    event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
    fields[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    ({ detail } = await event);
    expect(detail.delay).to.equal(0);
    expect(detail.options.query).to.equal('foo');
  });
});
