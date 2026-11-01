import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../search-results.js';

/** @typedef {import('../search-results.js').AcpSearchResults} AcpSearchResults */
/** @typedef {import('../../../hooks/search/types.js').SearchFileResult} SearchFileResult */

/** @type {SearchFileResult[]} */
const RESULTS = [
  {
    path: 'src/a/main.js',
    matches: [
      { line: 3, text: '  const foo = foo;', offset: 0, ranges: [[8, 11], [14, 17]] },
      { line: 10, text: 'foo()', offset: 0, ranges: [[0, 3]] },
    ],
  },
  { path: 'README.md', matches: [{ line: 1, text: 'a foo', offset: 0, ranges: [[2, 5]] }] },
];

/** @param {AcpSearchResults} el */
const shadow = (el) => /** @type {ShadowRoot} */ (el.shadowRoot);
/** @param {AcpSearchResults} el */
const rows = (el) => /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-results__row')]);
/** @param {AcpSearchResults} el */
const fileRows = (el) => /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-results__file')]);
/** @param {AcpSearchResults} el */
const selectedIndex = (el) => rows(el).findIndex((r) => r.getAttribute('aria-selected') === 'true');

/**
 * A row's text as `[text, highlighted]` parts.
 * @param {HTMLElement} row
 */
const parts = (row) =>
  [...(row.querySelector('.acp-search-results__text')?.childNodes ?? [])]
    .filter((n) => n.nodeType !== Node.COMMENT_NODE && n.textContent)
    .map((n) => [n.textContent, n instanceof HTMLElement && n.matches('mark.acp-search-results__hit')]);

/**
 * @param {import('lit').TemplateResult} template
 * @returns {Promise<AcpSearchResults>}
 */
const render = (template) => fixture(template);

/**
 * Collects the element's events of `type`.
 * @param {HTMLElement} el
 * @param {string} type
 */
function collect(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

describe('acp-search-results', () => {
  describe('grouped, not selectable (the pane)', () => {
    it('renders file rows with icon, name, folder, count and path tooltip, and one row per match with its hit marked', async () => {
      // Arrange + Act
      const el = await render(html`<acp-search-results .results=${RESULTS}></acp-search-results>`);
      // Assert
      expect(fileRows(el).map((f) => [
        f.querySelector('.acp-search-results__file-name')?.textContent,
        f.querySelector('.acp-search-results__file-dir')?.textContent,
        f.querySelector('.acp-search-results__count')?.textContent,
        f.querySelector('acp-file-icon')?.getAttribute('name'),
      ])).to.deep.equal([['main.js', 'src/a', '3', 'main.js'], ['README.md', '', '1', 'README.md']]);
      expect(fileRows(el).map(tooltipOf)).to.deep.equal(['src/a/main.js', 'README.md']);
      expect(rows(el).map((r) => r.querySelector('.acp-search-results__line')?.textContent)).to.deep.equal(['3', '3', '10', '1']);
      expect(parts(rows(el)[0])).to.deep.equal([['const ', false], ['foo', true], [' = foo;', false]]);
      expect(parts(rows(el)[1])).to.deep.equal([['const foo = ', false], ['foo', true], [';', false]]);
      expect(shadow(el).querySelector('[title]')).to.equal(null);
      expect(shadow(el).querySelector('[role="listbox"]')).to.equal(null);
      expect(rows(el)[0] instanceof HTMLButtonElement).to.equal(true);
    });

    it('fires open with the row on a click', async () => {
      const el = await render(html`<acp-search-results .results=${RESULTS}></acp-search-results>`);
      const events = collect(el, 'acp-search-result-open');
      rows(el)[2].click();
      expect(events.length).to.equal(1);
      expect(events[0].detail.row).to.include({ path: 'src/a/main.js', line: 10, column: 1, length: 3 });
      expect(events[0].bubbles && events[0].composed).to.equal(true);
    });

    it('collapses and expands a file, and expands all when the results empty', async () => {
      const el = await render(html`<acp-search-results .results=${RESULTS}></acp-search-results>`);
      fileRows(el)[0].click();
      await el.updateComplete;
      expect(fileRows(el)[0].getAttribute('aria-expanded')).to.equal('false');
      expect(rows(el).length).to.equal(1);
      fileRows(el)[0].click();
      await el.updateComplete;
      expect(rows(el).length).to.equal(4);

      fileRows(el)[0].click();
      await el.updateComplete;
      el.results = [];
      await el.updateComplete;
      el.results = RESULTS;
      await el.updateComplete;
      expect(fileRows(el)[0].getAttribute('aria-expanded')).to.equal('true');
      expect(rows(el).length).to.equal(4);
    });

    it('notes the limit at the end of the list', async () => {
      const el = await render(html`<acp-search-results .results=${RESULTS}></acp-search-results>`);
      expect(shadow(el).querySelector('.acp-search-results__note')).to.equal(null);
      el.limitHit = true;
      await el.updateComplete;
      expect(shadow(el).querySelector('.acp-search-results__note')?.textContent?.replace(/\s+/g, ' ').trim()).to.equal(
        'Showing the first 2000 results. Narrow the search with a folder or a mask.',
      );
    });
  });

  describe('flat', () => {
    it('lists rows without file rows, each with its file name and line', async () => {
      const el = await render(html`<acp-search-results view="flat" .results=${RESULTS}></acp-search-results>`);
      expect(fileRows(el).length).to.equal(0);
      const locations = rows(el).map((r) => r.querySelector('.acp-search-results__location'));
      expect(locations.map((l) => l?.textContent?.trim())).to.deep.equal(['main.js:3', 'main.js:3', 'main.js:10', 'README.md:1']);
      expect(tooltipOf(locations[2])).to.equal('src/a/main.js');
      expect(shadow(el).querySelector('[title]')).to.equal(null);
    });
  });

  describe('selectable (the dialog)', () => {
    it('is a listbox whose first row is selected, and announces it', async () => {
      const el = await render(html`<acp-search-results selectable></acp-search-results>`);
      const events = collect(el, 'acp-search-result-select');
      el.results = RESULTS;
      await el.updateComplete;
      expect(shadow(el).querySelector('[role="listbox"]')).to.not.equal(null);
      expect(rows(el).every((r) => r.getAttribute('role') === 'option')).to.equal(true);
      expect(selectedIndex(el)).to.equal(0);
      expect(el.selectedRow?.key).to.equal('src/a/main.js:3:8');
      expect(events.at(-1)?.detail.row.key).to.equal('src/a/main.js:3:8');
    });

    it('keeps the selection by key while results stream in, and selects the first row of a new search', async () => {
      const el = await render(html`<acp-search-results selectable .results=${RESULTS.slice(0, 1)}></acp-search-results>`);
      el.move(1);
      await el.updateComplete;
      expect(el.selectedRow?.key).to.equal('src/a/main.js:3:14');
      el.results = RESULTS;
      await el.updateComplete;
      expect(el.selectedRow?.key).to.equal('src/a/main.js:3:14');

      el.results = [];
      await el.updateComplete;
      expect(el.selectedRow).to.equal(null);
      el.results = RESULTS.slice(1);
      await el.updateComplete;
      expect(el.selectedRow?.key).to.equal('README.md:1:2');
    });

    it('moves the selection by step or to the ends and announces each row; collapsing its file moves it out', async () => {
      const el = await render(html`<acp-search-results selectable .results=${RESULTS}></acp-search-results>`);
      const events = collect(el, 'acp-search-result-select');
      for (const [move, expected] of /** @type {[() => void, number][]} */ ([
        [() => el.move(-1), 3],
        [() => el.move(1), 0],
        [() => el.moveTo('last'), 3],
        [() => el.moveTo('first'), 0],
      ])) {
        // Act
        move();
        await el.updateComplete;
        // Assert
        expect(selectedIndex(el)).to.equal(expected);
      }
      expect(events.map((e) => e.detail.row.key)).to.deep.equal([
        'README.md:1:2',
        'src/a/main.js:3:8',
        'README.md:1:2',
        'src/a/main.js:3:8',
      ]);

      // Act
      fileRows(el)[0].click();
      await el.updateComplete;
      // Assert
      expect(el.selectedRow?.key).to.equal('README.md:1:2');
      el.move(1);
      await el.updateComplete;
      expect(el.selectedRow?.key, 'collapsed rows are skipped').to.equal('README.md:1:2');
    });

    it('selects on a click and opens on a double-click', async () => {
      const el = await render(html`<acp-search-results selectable .results=${RESULTS}></acp-search-results>`);
      const opened = collect(el, 'acp-search-result-open');
      rows(el)[2].click();
      await el.updateComplete;
      expect(el.selectedRow?.key).to.equal('src/a/main.js:10:0');
      expect(opened.length).to.equal(0);
      rows(el)[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
      expect(opened.map((e) => e.detail.row.key)).to.deep.equal(['src/a/main.js:10:0']);
    });
  });
});
