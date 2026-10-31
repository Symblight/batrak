import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-search-panel.js';

/** @typedef {import('../acp-search-panel.js').AcpSearchPanel} AcpSearchPanel */

/** @param {Element} el */
const shadow = (el) => /** @type {ShadowRoot} */ (el.shadowRoot);

/** The pane's results block's shadow root. @param {Element} el */
const list = (el) => shadow(/** @type {Element} */ (shadow(el).querySelector('acp-search-results')));

/** The pane's option toggles. @param {Element} el */
const optionButtons = (el) =>
  /** @type {HTMLElement[]} */ ([
    ...shadow(/** @type {Element} */ (shadow(el).querySelector('acp-search-options'))).querySelectorAll('.acp-search-options__option'),
  ]);

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

describe('acp-search-panel', () => {
  it("names each option and each result's path in tooltips, not titles", async () => {
    const el = await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`);
    expect(optionButtons(el).map(tooltipOf)).to.deep.equal([
      'Match case (Alt+C)',
      'Match whole word (Alt+W)',
      'Use regular expression (Alt+R)',
    ]);
    expect(tooltipOf(list(el).querySelector('.acp-search-results__file'))).to.equal('src/a/main.js');
    expect(shadow(el).querySelector('[title]')).to.equal(null);
  });

  it('renders results grouped by file with name, folder, count and one row per match', async () => {
    const el = await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`);
    const root = list(el);
    const headers = [...root.querySelectorAll('.acp-search-results__file')];
    expect(headers.map((h) => [
      h.querySelector('.acp-search-results__file-name')?.textContent,
      h.querySelector('.acp-search-results__file-dir')?.textContent,
      h.querySelector('.acp-search-results__count')?.textContent,
    ])).to.deep.equal([['main.js', 'src/a', '3'], ['README.md', '', '1']]);
    const rows = [...root.querySelectorAll('.acp-search-results__row')];
    expect(rows.map((r) => r.querySelector('.acp-search-results__line')?.textContent)).to.deep.equal(['3', '3', '10', '1']);
    expect(rows[0].querySelector('.acp-search-results__text')?.textContent).to.equal('const foo = foo;');
  });

  it('opens a clicked match by its root-relative path, line, column and length', async () => {
    const el = await fixture(html`<acp-search-panel .results=${results}></acp-search-panel>`);
    const match = /** @type {HTMLButtonElement} */ (list(el).querySelectorAll('.acp-search-results__row')[1]);
    const event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search-panel-open'));
    /** @type {Event[]} */
    const leaked = [];
    el.addEventListener('acp-search-result-open', (/** @type {Event} */ e) => leaked.push(e));
    match.click();
    const e = await event;
    expect(e.detail).to.deep.equal({ path: 'src/a/main.js', line: 3, column: 13, length: 3 });
    expect(e.bubbles).to.equal(true);
    expect(e.composed).to.equal(true);
    expect(leaked).to.deep.equal([], "the block's own event stops at the pane");
  });

  it('summarizes the search: searching, no results, counts, the limit and errors', async () => {
    const el = /** @type {AcpSearchPanel} */ (await fixture(html`<acp-search-panel searching .results=${results}></acp-search-panel>`));
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
    expect(list(el).querySelector('.acp-search-results__note')).to.not.equal(null);
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
    for (const [i, option] of /** @type {const} */ (['caseSensitive', 'wholeWord', 'regex']).entries()) {
      const event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
      optionButtons(el)[i].click();
      const { detail } = await event;
      expect(detail.delay).to.equal(0);
      expect(detail.options[option]).to.equal(true);
      await el.updateComplete;
      expect(optionButtons(el)[i].hasAttribute('selected')).to.equal(true);
    }
  });

  it('toggles the options with Alt+C / Alt+W / Alt+R in any field, by key code', async () => {
    const el = await fixture(html`<acp-search-panel></acp-search-panel>`);
    const fields = [...shadow(el).querySelectorAll('md-text-field')];
    for (const [code, option, field] of /** @type {const} */ ([
      ['KeyC', 'caseSensitive', 0],
      ['KeyW', 'wholeWord', 1],
      ['KeyR', 'regex', 2],
    ])) {
      const event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
      const key = new KeyboardEvent('keydown', { key: 'ç', code, altKey: true, bubbles: true, composed: true, cancelable: true });
      fields[field].dispatchEvent(key);
      const { detail } = await event;
      expect(key.defaultPrevented).to.equal(true);
      expect(detail).to.include({ delay: 0 });
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

  it('takes options from outside, fills its fields and searches at once', async () => {
    const el = /** @type {AcpSearchPanel} */ (await fixture(html`<acp-search-panel></acp-search-panel>`));
    const options = { query: 'bar', caseSensitive: true, wholeWord: false, regex: true, include: 'src/**/*.ts', exclude: '**/*.test.ts' };
    const event = /** @type {Promise<CustomEvent>} */ (nextEvent(el, 'acp-search'));
    el.setOptions(options);
    expect((await event).detail).to.deep.equal({ options, delay: 0 });
    await el.updateComplete;
    const fields = /** @type {HTMLElementTagNameMap['md-text-field'][]} */ ([...shadow(el).querySelectorAll('md-text-field')]);
    expect(fields.map((f) => f.value)).to.deep.equal(['bar', 'src/**/*.ts', '**/*.test.ts']);
    expect(optionButtons(el).map((b) => b.hasAttribute('selected'))).to.deep.equal([true, false, true]);
  });
});
