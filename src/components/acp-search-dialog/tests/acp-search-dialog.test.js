import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-search-dialog.js';

/** @typedef {import('../acp-search-dialog.js').AcpSearchDialog} AcpSearchDialog */
/** @typedef {import('../../../models/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../../models/types.js').SearchDialogState} SearchDialogState */

/** @type {SearchDialogState} */
const STATE = { query: 'last', caseSensitive: false, wholeWord: true, regex: false, folder: 'src', mask: '*.ts' };

/** @type {SearchFileResult[]} */
const RESULTS = [
  {
    path: 'src/a/main.ts',
    matches: [
      { line: 3, text: 'const foo = foo;', offset: 0, ranges: [[6, 9], [12, 15]] },
      { line: 10, text: 'foo()', offset: 0, ranges: [[0, 3]] },
    ],
  },
  { path: 'src/b.ts', matches: [{ line: 1, text: 'a foo', offset: 0, ranges: [[2, 5]] }] },
];

/** @param {Element} el */
const shadow = (el) => /** @type {ShadowRoot} */ (el.shadowRoot);
/** @param {AcpSearchDialog} el */
const input = (el) => /** @type {HTMLInputElement} */ (shadow(el).querySelector('.acp-search-dialog__input'));
/** @param {AcpSearchDialog} el */
const results = (el) => /** @type {HTMLElementTagNameMap['acp-search-results']} */ (shadow(el).querySelector('acp-search-results'));
/** @param {AcpSearchDialog} el */
const dialog = (el) => /** @type {HTMLDialogElement} */ (shadow(el).querySelector('dialog'));
/**
 * @param {AcpSearchDialog} el
 * @param {string} selector
 */
const text = (el, selector) => (shadow(el).querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

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

/**
 * A keydown in the search input.
 * @param {AcpSearchDialog} el
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function press(el, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init });
  input(el).dispatchEvent(event);
  return event;
}

/**
 * Types into the search input like a user would.
 * @param {AcpSearchDialog} el
 * @param {string} value
 */
function type(el, value) {
  input(el).value = value;
  input(el).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

/**
 * An open dialog with `props` set, after `show(state, selection)`.
 * @param {Partial<AcpSearchDialog>} [props]
 * @param {SearchDialogState} [state]
 * @param {string} [selection]
 */
async function open(props = {}, state = STATE, selection) {
  const el = /** @type {AcpSearchDialog} */ (await fixture(html`<acp-search-dialog .hasProject=${true}></acp-search-dialog>`));
  Object.assign(el, props);
  const queries = collect(el, 'acp-search-dialog-query');
  await el.show(state, selection);
  await el.updateComplete;
  return { el, queries };
}

afterEach(() => {
  for (const el of document.querySelectorAll('acp-search-dialog')) {
    el.close();
    el.parentElement?.remove();
  }
});

describe('acp-search-dialog', () => {
  describe('opening and closing', () => {
    it("opens with the project's last state, the query selected, and searches it", async () => {
      const { el, queries } = await open();
      expect(el.open).to.equal(true);
      expect(input(el).value).to.equal('last');
      expect(shadow(el).activeElement).to.equal(input(el));
      expect([input(el).selectionStart, input(el).selectionEnd]).to.deep.equal([0, 4]);
      expect(queries.map((e) => e.detail)).to.deep.equal([
        {
          delay: 0,
          options: { query: 'last', caseSensitive: false, wholeWord: true, regex: false, include: 'src/**/*.ts', exclude: '' },
          state: STATE,
        },
      ]);
    });

    it('opens with the editor selection when it is one line', async () => {
      const { el, queries } = await open({}, STATE, '  needle ');
      expect(input(el).value).to.equal('needle');
      expect(queries[0].detail.state.query).to.equal('needle');
    });

    it('selects the query when shown again while open, without searching again', async () => {
      const { el, queries } = await open();
      type(el, 'other');
      input(el).setSelectionRange(5, 5);
      await el.show({ ...STATE, query: 'ignored' });
      expect(input(el).value).to.equal('other');
      expect([input(el).selectionStart, input(el).selectionEnd]).to.deep.equal([0, 5]);
      expect(queries.filter((e) => e.detail.delay === 0).length).to.equal(1);
    });

    it('closes on Escape, telling the container, and gives focus back', async () => {
      const before = document.createElement('button');
      document.body.append(before);
      before.focus();
      const { el } = await open();
      const closes = collect(el, 'acp-search-dialog-close');
      const closed = new Promise((r) => dialog(el).addEventListener('close', r, { once: true }));
      const esc = press(el, 'Escape');
      await closed;
      expect(esc.defaultPrevented).to.equal(true);
      expect(el.open).to.equal(false);
      expect(closes.length).to.equal(1);
      expect(document.activeElement).to.equal(before);
      before.remove();
    });

    it('leaves focus to the container after opening a result or handing over', async () => {
      for (const action of ['open', 'popout']) {
        const before = document.createElement('button');
        const target = document.createElement('button');
        document.body.append(before, target);
        before.focus();
        const { el } = await open({ results: RESULTS });
        // The container focuses the tab or the pane once it has handled the event.
        el.addEventListener(`acp-search-dialog-${action}`, () => queueMicrotask(() => target.focus()));
        const closed = new Promise((r) => dialog(el).addEventListener('close', r, { once: true }));
        if (action === 'open') press(el, 'Enter');
        else /** @type {HTMLElement} */ (shadow(el).querySelectorAll('.acp-search-dialog__layout-button')[2]).click();
        await closed;
        expect(document.activeElement, action).to.equal(target);
        before.remove();
        target.remove();
        el.parentElement?.remove();
      }
    });

    it('keeps Escape while an IME composes', async () => {
      const { el } = await open();
      press(el, 'Escape', { isComposing: true });
      expect(el.open).to.equal(true);
    });

    it('stays open when a selection drag from the input ends on the scrim', async () => {
      const { el } = await open();
      input(el).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      dialog(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.open).to.equal(true);
    });

    it('closes on a click on the scrim, not inside', async () => {
      const { el } = await open();
      const header = /** @type {HTMLElement} */ (shadow(el).querySelector('.acp-search-dialog__header'));
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      header.click();
      expect(el.open).to.equal(true);
      dialog(el).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      dialog(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.open).to.equal(false);
    });

    it('says to open a project without one, and searches nothing', async () => {
      const el = /** @type {AcpSearchDialog} */ (await fixture(html`<acp-search-dialog></acp-search-dialog>`));
      const queries = collect(el, 'acp-search-dialog-query');
      await el.show(STATE);
      await el.updateComplete;
      expect(text(el, '.acp-search-dialog__body')).to.equal('Open a project first');
      type(el, 'x');
      expect(queries).to.deep.equal([]);
    });
  });

  describe('the search bar', () => {
    it('searches after a pause while typing, with the state to save', async () => {
      const { el, queries } = await open();
      type(el, 'foo');
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 150, state: { ...STATE, query: 'foo' } });
      expect(queries.at(-1)?.detail.options.query).to.equal('foo');
    });

    it('toggles options by click and Alt+C / W / R, searching at once', async () => {
      const { el, queries } = await open();
      const options = /** @type {HTMLElementTagNameMap['acp-search-options']} */ (shadow(el).querySelector('acp-search-options'));
      /** @type {HTMLElement} */ (shadow(options).querySelector('.acp-search-options__option')).click();
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.options.caseSensitive).to.equal(true);

      const alt = press(el, 'ç', { code: 'KeyR', altKey: true });
      expect(alt.defaultPrevented).to.equal(true);
      expect(queries.at(-1)?.detail.options.regex).to.equal(true);
      press(el, 'w', { code: 'KeyW', altKey: true });
      expect(queries.at(-1)?.detail.options.wholeWord).to.equal(false);
      await el.updateComplete;
      expect([options.caseSensitive, options.wholeWord, options.regex]).to.deep.equal([true, false, true]);
    });

    it('clears the query and searches at once', async () => {
      const { el, queries } = await open();
      const clear = /** @type {HTMLElement} */ (shadow(el).querySelector('.acp-search-dialog__clear'));
      expect(tooltipOf(clear)).to.equal('Clear');
      clear.click();
      await el.updateComplete;
      expect(input(el).value).to.equal('');
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.options.query).to.equal('');
      expect(shadow(el).querySelector('.acp-search-dialog__clear')).to.equal(null);
    });

    it('searches a query of spaces and shows its results', async () => {
      const { el, queries } = await open({ recent: ['alpha'] });
      type(el, '  ');
      expect(queries.at(-1)?.detail.options.query).to.equal('  ');
      el.results = RESULTS;
      await el.updateComplete;
      expect(results(el)).to.not.equal(null);
      expect(shadow(el).querySelector('.acp-search-dialog__recent')).to.equal(null);
      expect(text(el, '.acp-search-dialog__summary')).to.equal('4 results in 2 files');
      expect(input(el).getAttribute('aria-expanded')).to.equal('true');
    });

    it('shows progress while searching', async () => {
      const { el } = await open({ searching: true });
      expect(shadow(el).querySelector('md-progress-linear.acp-search-dialog__progress')).to.not.equal(null);
      el.searching = false;
      await el.updateComplete;
      expect(shadow(el).querySelector('md-progress-linear')).to.equal(null);
    });
  });

  describe('results and keys', () => {
    it('lists the results selectable, with the summary', async () => {
      const { el } = await open({ results: RESULTS });
      expect(results(el).selectable).to.equal(true);
      expect(results(el).selectedRow?.key).to.equal('src/a/main.ts:3:6');
      expect(text(el, '.acp-search-dialog__summary')).to.equal('4 results in 2 files');
      expect(input(el).getAttribute('role')).to.equal('combobox');
    });

    it('moves the selection with the arrows, pages and Mod+arrows, keeping focus in the input', async () => {
      const { el } = await open({ results: RESULTS });
      const keys = () => results(el).selectedRow?.key;
      for (const [key, init, expected] of /** @type {[string, KeyboardEventInit, string][]} */ ([
        ['ArrowDown', {}, 'src/a/main.ts:3:12'],
        ['ArrowUp', {}, 'src/a/main.ts:3:6'],
        ['ArrowUp', {}, 'src/b.ts:1:2'],
        ['PageUp', {}, 'src/a/main.ts:3:6'],
        ['PageDown', {}, 'src/b.ts:1:2'],
        ['ArrowUp', { metaKey: true }, 'src/a/main.ts:3:6'],
        ['ArrowDown', { ctrlKey: true }, 'src/b.ts:1:2'],
      ])) {
        const event = press(el, key, init);
        await el.updateComplete;
        await results(el).updateComplete;
        expect(event.defaultPrevented, key).to.equal(true);
        expect(keys(), `${key} ${JSON.stringify(init)}`).to.equal(expected);
      }
      expect(shadow(el).activeElement).to.equal(input(el));
    });

    it('announces the selected row', async () => {
      const { el } = await open({ results: RESULTS });
      await results(el).updateComplete;
      await el.updateComplete;
      const status = shadow(el).querySelector('.acp-search-dialog__status');
      expect(status?.getAttribute('aria-live')).to.equal('polite');
      expect(status?.textContent?.trim()).to.equal('main.ts:3 — const foo = foo;');
    });

    it('opens the selected match on Enter and closes', async () => {
      const { el } = await open({ results: RESULTS });
      const opened = collect(el, 'acp-search-dialog-open');
      const leaked = collect(el, 'acp-search-result-open');
      press(el, 'ArrowDown');
      await el.updateComplete;
      press(el, 'Enter');
      expect(opened.map((e) => e.detail)).to.deep.equal([{ path: 'src/a/main.ts', line: 3, column: 13, length: 3, state: STATE }]);
      expect(opened[0].bubbles && opened[0].composed).to.equal(true);
      expect(leaked).to.deep.equal([]);
      expect(el.open).to.equal(false);
    });

    it('opens a double-clicked match', async () => {
      const { el } = await open({ results: RESULTS });
      const opened = collect(el, 'acp-search-dialog-open');
      const row = /** @type {HTMLElement} */ (shadow(results(el)).querySelectorAll('.acp-search-results__row')[3]);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
      expect(opened.map((e) => e.detail.path)).to.deep.equal(['src/b.ts']);
      expect(el.open).to.equal(false);
    });

    it('does nothing on Enter without results', async () => {
      const { el } = await open({ results: [] });
      const opened = collect(el, 'acp-search-dialog-open');
      press(el, 'Enter');
      expect(opened).to.deep.equal([]);
      expect(el.open).to.equal(true);
    });
  });

  describe('states', () => {
    it('lists recent searches for an empty query; arrows pick one, Enter searches it', async () => {
      const { el, queries } = await open({ recent: ['alpha', 'beta'] }, { ...STATE, query: '' });
      expect(text(el, '.acp-search-dialog__heading')).to.equal('Recent searches');
      const items = () => [...shadow(el).querySelectorAll('.acp-search-dialog__recent-item')];
      expect(items().map((i) => i.textContent?.trim())).to.deep.equal(['alpha', 'beta']);
      expect(items()[0].getAttribute('aria-selected')).to.equal('true');
      press(el, 'ArrowDown');
      await el.updateComplete;
      expect(items()[1].getAttribute('aria-selected')).to.equal('true');
      press(el, 'Enter');
      await el.updateComplete;
      expect(input(el).value).to.equal('beta');
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.options.query).to.equal('beta');
      expect(el.open).to.equal(true);
    });

    it('searches a clicked recent query', async () => {
      const { el, queries } = await open({ recent: ['alpha', 'beta'] }, { ...STATE, query: '' });
      /** @type {HTMLElement} */ (shadow(el).querySelectorAll('.acp-search-dialog__recent-item')[0]).click();
      expect(queries.at(-1)?.detail.options.query).to.equal('alpha');
    });

    it('invites typing with no recent searches', async () => {
      const { el } = await open({}, { ...STATE, query: '' });
      expect(text(el, '.acp-search-dialog__body')).to.equal('Type to search in files');
    });

    it('says where nothing was found, and searches the whole project on request', async () => {
      const { el, queries } = await open({ results: [] });
      expect(text(el, '.acp-search-dialog__empty')).to.contain('No results for last');
      expect(text(el, '.acp-search-dialog__empty')).to.contain('in src, *.ts');
      /** @type {HTMLElement} */ (shadow(el).querySelector('.acp-search-dialog__empty-action')).click();
      expect(queries.at(-1)?.detail.state).to.deep.include({ folder: '', mask: '' });
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: '', exclude: '' });
      await el.updateComplete;
      expect(shadow(el).querySelector('.acp-search-dialog__empty-action'), 'no filters left to clear').to.equal(null);
    });

    it('shows nothing-found only once the search is done', async () => {
      const { el } = await open({ results: [], searching: true });
      expect(shadow(el).querySelector('.acp-search-dialog__empty')).to.equal(null);
    });

    it('marks a bad regex and offers to search as plain text', async () => {
      const { el, queries } = await open({ error: 'unclosed group', errorSource: 'query' }, { ...STATE, regex: true });
      expect(shadow(el).querySelector('.acp-search-dialog__bar_error')).to.not.equal(null);
      expect(text(el, '.acp-search-dialog__empty')).to.contain('Invalid regular expression');
      expect(text(el, '.acp-search-dialog__empty')).to.contain('unclosed group');
      /** @type {HTMLElement} */ (shadow(el).querySelector('.acp-search-dialog__empty-action')).click();
      expect(queries.at(-1)?.detail.options.regex).to.equal(false);
      expect(queries.at(-1)?.detail.delay).to.equal(0);
    });

    it('shows a bad filter without the plain-text offer', async () => {
      const { el } = await open({ error: 'unclosed class', errorSource: 'filter' }, { ...STATE, regex: true });
      expect(shadow(el).querySelector('.acp-search-dialog__bar_error')).to.equal(null);
      expect(text(el, '.acp-search-dialog__empty')).to.contain('unclosed class');
      expect(text(el, '.acp-search-dialog__empty')).to.not.contain('Invalid regular expression');
      expect(shadow(el).querySelector('.acp-search-dialog__empty-action')).to.equal(null);
      expect(shadow(el).querySelector('.acp-search-dialog__summary_error')).to.not.equal(null);
    });

    it('passes the limit to the list', async () => {
      const { el } = await open({ results: RESULTS, limitHit: true });
      expect(results(el).limitHit).to.equal(true);
    });
  });

  describe('header and layout', () => {
    /** @param {AcpSearchDialog} el */
    const buttons = (el) => /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-dialog__layout-button')]);
    /** @param {AcpSearchDialog} el */
    const viewButtons = (el) => /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-dialog__view-button')]);

    it('names its buttons in tooltips, not titles', async () => {
      const { el } = await open({ results: RESULTS });
      expect(text(el, '.acp-search-dialog__title')).to.equal('Search in files');
      expect(buttons(el).map(tooltipOf)).to.deep.equal(['Preview below', 'Preview on the right', 'Open in panel']);
      expect(viewButtons(el).map(tooltipOf)).to.deep.equal(['Group by file', 'Flat list']);
      expect(shadow(el).querySelector('[title]')).to.equal(null);
    });

    it('asks for a preview position; pressing the current one hides the preview', async () => {
      const { el } = await open({ previewPosition: 'bottom' });
      expect(el.getAttribute('preview-position')).to.equal('bottom');
      const prefs = collect(el, 'acp-search-dialog-prefs');
      buttons(el)[1].click();
      buttons(el)[0].click();
      expect(prefs.map((e) => e.detail)).to.deep.equal([{ patch: { preview: 'right' } }, { patch: { preview: 'none' } }]);
      expect(buttons(el).slice(0, 2).map((b) => b.getAttribute('aria-pressed'))).to.deep.equal(['true', 'false']);
    });

    it('asks for a view', async () => {
      const { el } = await open({ results: RESULTS, view: 'grouped' });
      const prefs = collect(el, 'acp-search-dialog-prefs');
      viewButtons(el)[1].click();
      expect(prefs.map((e) => e.detail)).to.deep.equal([{ patch: { view: 'flat' } }]);
      el.view = 'flat';
      await el.updateComplete;
      expect(el.getAttribute('view')).to.equal('flat');
      expect(results(el).view).to.equal('flat');
      expect(viewButtons(el).map((b) => b.getAttribute('aria-checked'))).to.deep.equal(['false', 'true']);
    });

    it('hands the search over to the panel and closes', async () => {
      const { el } = await open();
      const popouts = collect(el, 'acp-search-dialog-popout');
      type(el, 'moved');
      buttons(el)[2].click();
      expect(popouts.map((e) => e.detail)).to.deep.equal([{ state: { ...STATE, query: 'moved' } }]);
      expect(el.open).to.equal(false);
    });
  });
});
