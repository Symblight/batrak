import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../search-dialog.js';

/** @typedef {import('../search-dialog.js').AcpSearchDialog} AcpSearchDialog */
/** @typedef {import('../../../models/types/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../../models/types/types.js').SearchDialogState} SearchDialogState */

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
  for (const el of document.querySelectorAll('acp-search-dialog')) el.close();
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

    it('shows the icon of a pressed layout or view button, as of an unpressed one', async () => {
      const { el } = await open({ previewPosition: 'bottom', view: 'grouped' });
      for (const button of [...buttons(el), ...viewButtons(el)]) {
        await /** @type {HTMLElement & { updateComplete: Promise<unknown> }} */ (button).updateComplete;
        const slot = button.shadowRoot?.querySelector('slot');
        expect(slot?.assignedElements().map((i) => i.localName), button.getAttribute('aria-label') ?? '').to.deep.equal(['md-icon']);
      }
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

  describe('filter chips', () => {
    /**
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     */
    const chip = (el, which) => /** @type {HTMLElement} */ (shadow(el).querySelector(`.acp-search-dialog__chip[data-filter="${which}"]`));
    /**
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     */
    const menu = (el, which) => /** @type {HTMLElementTagNameMap['md-menu']} */ (shadow(el).querySelector(`.acp-search-dialog__menu[data-filter="${which}"]`));
    /**
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     */
    const field = (el, which) => /** @type {HTMLElementTagNameMap['md-text-field']} */ (menu(el, which).querySelector('.acp-search-dialog__menu-field'));

    /**
     * Polls until `pred` holds; fails after 2s.
     * @param {() => boolean} pred
     */
    async function until(pred) {
      const started = Date.now();
      while (!pred()) {
        expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    /**
     * Opens a chip's menu and waits for it.
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     */
    async function openMenu(el, which) {
      chip(el, which).click();
      await el.updateComplete;
      await until(() => menu(el, which).open);
    }

    /**
     * Picks a menu item as a click would.
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     * @param {string} value
     */
    function pick(el, which, value) {
      const item = /** @type {HTMLElement} */ (menu(el, which).querySelector(`md-menu-item[value="${CSS.escape(value)}"]`));
      item.dispatchEvent(new CustomEvent('select', { detail: { value, item }, bubbles: true, composed: true }));
    }

    /**
     * Types into a menu's field and presses `key`.
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     * @param {string} value
     */
    function typeIn(el, which, value) {
      field(el, which).value = value;
      field(el, which).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    it('shows an unset filter as a filter chip and a set one as a removable input chip', async () => {
      const { el } = await open({}, { ...STATE, folder: '', mask: '' });
      expect(chip(el, 'folder').localName).to.equal('md-filter-chip');
      expect(chip(el, 'folder').textContent?.trim()).to.equal('Folder');
      expect(chip(el, 'mask').localName).to.equal('md-filter-chip');
      expect(chip(el, 'mask').textContent?.trim()).to.equal('File mask');
      el.close();

      const set = await open();
      expect(chip(set.el, 'folder').localName).to.equal('md-input-chip');
      expect(chip(set.el, 'folder').textContent?.trim()).to.equal('src');
      expect(chip(set.el, 'mask').textContent?.trim()).to.equal('*.ts');
    });

    it('clears a filter with its remove button and searches at once', async () => {
      const { el, queries } = await open();
      chip(el, 'folder').dispatchEvent(new Event('remove', { bubbles: true, composed: true }));
      await el.updateComplete;
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.state).to.deep.include({ folder: '', mask: '*.ts' });
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: '**/*.ts', exclude: '' });
      expect(chip(el, 'folder').localName).to.equal('md-filter-chip');
      expect(menu(el, 'folder').open).to.equal(false);
      expect(shadow(el).activeElement, 'not lost with the removed chip').to.equal(input(el));
    });

    it("asks for the project's folders as the folder menu opens and as its field is typed in", async () => {
      const { el } = await open({}, { ...STATE, folder: '' });
      const asked = collect(el, 'acp-search-dialog-folders');
      await openMenu(el, 'folder');
      expect(asked.map((e) => e.detail)).to.deep.equal([{ query: '' }]);
      typeIn(el, 'folder', 'comp');
      expect(asked.map((e) => e.detail)).to.deep.equal([{ query: '' }, { query: 'comp' }]);
    });

    it('lists the folders with the current one checked; a pick sets it and searches', async () => {
      const { el, queries } = await open();
      el.folders = [
        { path: 'src', name: 'src', isDir: true, indices: [] },
        { path: 'src/components', name: 'components', isDir: true, indices: [] },
      ];
      await openMenu(el, 'folder');
      const items = [...menu(el, 'folder').querySelectorAll('md-menu-item')];
      expect(items.map((i) => i.getAttribute('value'))).to.deep.equal(['src', 'src/components']);
      expect(items.map((i) => i.hasAttribute('selected'))).to.deep.equal([true, false]);
      const leaked = collect(el, 'select');
      const before = queries.length;
      pick(el, 'folder', 'src/components');
      await el.updateComplete;
      expect(leaked, "the menu's select stays inside").to.deep.equal([]);
      expect(queries.length - before, 'one search per pick').to.equal(1);
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.state.folder).to.equal('src/components');
      expect(queries.at(-1)?.detail.options.include).to.equal('src/components/**/*.ts');
      expect(chip(el, 'folder').textContent?.trim()).to.equal('src/components');
    });

    it('sets the mask from its field on Enter, and searches with it', async () => {
      const { el, queries } = await open({}, { ...STATE, folder: '', mask: '' });
      await openMenu(el, 'mask');
      typeIn(el, 'mask', ' *.ts, !*.test.ts ');
      expect(queries.at(-1)?.detail.state.mask, 'typing alone does not search').to.equal('');
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
      field(el, 'mask').dispatchEvent(enter);
      await el.updateComplete;
      expect(queries.at(-1)?.detail.state.mask).to.equal('*.ts, !*.test.ts');
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: '**/*.ts', exclude: '**/*.test.ts' });
      await until(() => !menu(el, 'mask').open);
      expect(chip(el, 'mask').textContent?.trim()).to.equal('*.ts, !*.test.ts');
    });

    it('offers mask presets; a pick sets the mask', async () => {
      const { el, queries } = await open({}, { ...STATE, mask: '' });
      await openMenu(el, 'mask');
      const presets = [...menu(el, 'mask').querySelectorAll('md-menu-item')].map((i) => i.getAttribute('value'));
      expect(presets).to.deep.equal(['*.{js,ts}', '*.css', '*.md', '!*.test.js', '!pnpm-lock.yaml']);
      pick(el, 'mask', '*.css');
      await el.updateComplete;
      expect(queries.at(-1)?.detail.state.mask).to.equal('*.css');
      expect(queries.at(-1)?.detail.options.include).to.equal('src/**/*.css');
    });

    it("keeps typing in a menu's field instead of jumping to an item", async () => {
      const { el } = await open({}, { ...STATE, mask: '' });
      await openMenu(el, 'mask');
      field(el, 'mask').focus();
      const key = new KeyboardEvent('keydown', { key: 'c', bubbles: true, composed: true, cancelable: true });
      field(el, 'mask').dispatchEvent(key);
      expect(key.defaultPrevented).to.equal(false);
      expect(shadow(el).activeElement).to.equal(field(el, 'mask'));
    });

    it('closes only the menu on Escape in it', async () => {
      const { el } = await open();
      await openMenu(el, 'mask');
      field(el, 'mask').focus();
      field(el, 'mask').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
      await until(() => !menu(el, 'mask').open);
      expect(el.open).to.equal(true);
      expect(shadow(el).activeElement, 'the keys work again').to.equal(input(el));
    });

    it('closes an open menu with the dialog', async () => {
      const { el } = await open();
      await openMenu(el, 'folder');
      const closed = new Promise((r) => dialog(el).addEventListener('close', r, { once: true }));
      el.close();
      await closed;
      await until(() => !menu(el, 'folder').open);
    });

    it('picks the first folder on Enter only from a list that answers the latest typing', async () => {
      const { el, queries } = await open({}, { ...STATE, folder: '' });
      el.folders = [{ path: 'old', name: 'old', isDir: true, indices: [] }];
      await openMenu(el, 'folder');
      const enter = () => field(el, 'folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
      enter();
      expect(queries.at(-1)?.detail.state.folder, 'an empty field picks nothing').to.equal('');
      typeIn(el, 'folder', 'comp');
      enter();
      expect(queries.at(-1)?.detail.state.folder, 'the list is for an older query').to.equal('');
      el.folders = [{ path: 'src/components', name: 'components', isDir: true, indices: [] }];
      el.foldersQuery = 'comp';
      await el.updateComplete;
      enter();
      expect(queries.at(-1)?.detail.state.folder).to.equal('src/components');
    });

    it('ignores a late answer to an older folder query on Enter', async () => {
      const { el, queries } = await open({}, { ...STATE, folder: '' });
      await openMenu(el, 'folder');
      typeIn(el, 'folder', 'co');
      typeIn(el, 'folder', 'comp');
      el.folders = [{ path: 'docs/co', name: 'co', isDir: true, indices: [] }];
      el.foldersQuery = 'co';
      await el.updateComplete;
      field(el, 'folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
      expect(queries.at(-1)?.detail.state.folder).to.equal('');
    });

    it('picks from an answer that repeats the previous list for the latest query', async () => {
      const { el, queries } = await open({}, { ...STATE, folder: '' });
      const list = [{ path: 'src/components', name: 'components', isDir: true, indices: [] }];
      await openMenu(el, 'folder');
      typeIn(el, 'folder', 'comp');
      el.folders = list;
      el.foldersQuery = 'comp';
      await el.updateComplete;
      typeIn(el, 'folder', 'compo');
      el.folders = list;
      el.foldersQuery = 'compo';
      await el.updateComplete;
      field(el, 'folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
      expect(queries.at(-1)?.detail.state.folder).to.equal('src/components');
    });

    it('closes the open menu when its filter is removed', async () => {
      const { el } = await open();
      await openMenu(el, 'mask');
      chip(el, 'mask').dispatchEvent(new Event('remove', { bubbles: true, composed: true }));
      await el.updateComplete;
      await until(() => !menu(el, 'mask').open);
    });

    it("keeps Esc in a menu's field while an IME composes, and lets Alt+C / W / R through", async () => {
      const { el, queries } = await open();
      await openMenu(el, 'mask');
      field(el, 'mask').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, composed: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      expect(menu(el, 'mask').open).to.equal(true);
      field(el, 'mask').dispatchEvent(new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true, composed: true, cancelable: true }));
      expect(queries.at(-1)?.detail.options.caseSensitive).to.equal(true);
    });
  });
});
