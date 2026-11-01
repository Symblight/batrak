import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../search-dialog.js';

/** @typedef {import('../search-dialog.js').AcpSearchDialog} AcpSearchDialog */
/** @typedef {import('../../../hooks/search/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../../hooks/search/types.js').SearchDialogState} SearchDialogState */

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
const bar = (el) => /** @type {HTMLElementTagNameMap['acp-search-bar']} */ (shadow(el).querySelector('acp-search-bar'));
/** @param {AcpSearchDialog} el */
const input = (el) => /** @type {HTMLInputElement} */ (bar(el).shadowRoot?.querySelector('input'));
/** @param {AcpSearchDialog} el */
const results = (el) => /** @type {HTMLElementTagNameMap['acp-search-results']} */ (shadow(el).querySelector('acp-search-results'));
/** @param {AcpSearchDialog} el */
const header = (el) => /** @type {HTMLElementTagNameMap['acp-search-header']} */ (shadow(el).querySelector('acp-search-header'));
/** @param {AcpSearchDialog} el */
const dialog = (el) => /** @type {HTMLDialogElement} */ (shadow(el).querySelector('dialog'));
/**
 * @param {AcpSearchDialog} el
 * @param {string} selector
 */
const text = (el, selector) => (shadow(el).querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Whether the query field has the focus (a boolean: chai would print a DOM node). @param {AcpSearchDialog} el */
const queryFocused = (el) => bar(el).shadowRoot?.activeElement === input(el);

/**
 * A child of the dialog by tag, and its shadow root's text.
 * @param {AcpSearchDialog} el
 * @param {string} tag
 */
const inner = (el, tag) => (shadow(el).querySelector(tag)?.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();

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
      expect(queryFocused(el)).to.equal(true);
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

    it('closes on Escape, telling the container, and gives focus back; an IME composing keeps it open', async () => {
      // Arrange
      const before = document.createElement('button');
      document.body.append(before);
      before.focus();
      const { el } = await open();
      const closes = collect(el, 'acp-search-dialog-close');
      const closed = new Promise((r) => dialog(el).addEventListener('close', r, { once: true }));
      // Act
      const composing = press(el, 'Escape', { isComposing: true });
      // Assert
      expect(composing.defaultPrevented).to.equal(false);
      expect(el.open).to.equal(true);
      // Act
      const esc = press(el, 'Escape');
      await closed;
      // Assert
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
        else /** @type {HTMLElement} */ (shadow(header(el)).querySelector('#acp-search-header-popout')).click();
        await closed;
        expect(document.activeElement, action).to.equal(target);
        before.remove();
        target.remove();
      }
    });

    it('closes on a click on the scrim, not inside and not when a selection drag from the input ends there', async () => {
      const { el } = await open();
      const title = header(el);
      title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      title.click();
      expect(el.open, 'a click inside').to.equal(true);

      input(el).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      dialog(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.open, 'a drag from the input ending on the scrim').to.equal(true);

      dialog(el).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      dialog(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.open, 'a click on the scrim').to.equal(false);
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
      const options = /** @type {HTMLElementTagNameMap['acp-search-options']} */ (shadow(bar(el)).querySelector('acp-search-options'));
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
      /** @type {HTMLElement} */ (shadow(bar(el)).querySelector('.acp-search-bar__clear')).click();
      await el.updateComplete;
      expect(input(el).value).to.equal('');
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.options.query).to.equal('');
      expect(shadow(bar(el)).querySelector('.acp-search-bar__clear')).to.equal(null);
    });

    it('searches a query of spaces and shows its results', async () => {
      const { el, queries } = await open({ recent: ['alpha'] });
      type(el, '  ');
      expect(queries.at(-1)?.detail.options.query).to.equal('  ');
      el.results = RESULTS;
      await el.updateComplete;
      expect(results(el)).to.not.equal(null);
      expect(shadow(el).querySelector('acp-search-recent')).to.equal(null);
      expect(text(el, '.acp-search-dialog__summary')).to.equal('4 results in 2 files');
      expect(input(el).getAttribute('aria-expanded')).to.equal('true');
    });
  });

  describe('results and keys', () => {
    it('lists the results selectable with the summary and the limit, and announces the selected row', async () => {
      const { el } = await open({ results: RESULTS, limitHit: true });
      await results(el).updateComplete;
      await el.updateComplete;
      expect(results(el).selectable).to.equal(true);
      expect(results(el).limitHit).to.equal(true);
      expect(results(el).selectedRow?.key).to.equal('src/a/main.ts:3:6');
      expect(text(el, '.acp-search-dialog__summary')).to.contain('4 results in 2 files');
      expect(input(el).getAttribute('role')).to.equal('combobox');
      const status = shadow(el).querySelector('.acp-search-dialog__status');
      expect(status?.getAttribute('aria-live')).to.equal('polite');
      expect(status?.textContent?.trim()).to.equal('main.ts:3 — const foo = foo;');
    });

    it('moves the selection with the arrows, pages and Mod+arrows, keeping focus in the input', async () => {
      const { el } = await open({ results: RESULTS });
      const keys = () => results(el).selectedRow?.key;
      for (const [key, init, expected] of /** @type {[string, KeyboardEventInit, string][]} */ ([
        ['ArrowDown', {}, 'src/a/main.ts:3:12'],
        ['ArrowUp', {}, 'src/a/main.ts:3:6'],
        ['PageDown', {}, 'src/b.ts:1:2'],
        ['PageUp', {}, 'src/a/main.ts:3:6'],
        ['ArrowDown', { ctrlKey: true }, 'src/b.ts:1:2'],
        ['ArrowUp', { metaKey: true }, 'src/a/main.ts:3:6'],
      ])) {
        const event = press(el, key, init);
        await el.updateComplete;
        await results(el).updateComplete;
        expect(event.defaultPrevented, key).to.equal(true);
        expect(keys(), `${key} ${JSON.stringify(init)}`).to.equal(expected);
      }
      expect(queryFocused(el)).to.equal(true);
      // A key on the clear button is not the query's: the arrows leave the selection alone.
      const before = keys();
      /** @type {HTMLElement} */ (shadow(bar(el)).querySelector('.acp-search-bar__clear')).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true, cancelable: true }));
      await el.updateComplete;
      expect(keys(), 'the clear button’s arrows').to.equal(before);
    });

    it('opens the selected match on Enter, or a double-clicked one, and closes', async () => {
      const cases = /** @type {[string, (el: AcpSearchDialog) => Promise<void>, object][]} */ ([
        [
          'Enter',
          async (el) => {
            press(el, 'ArrowDown');
            await el.updateComplete;
            press(el, 'Enter');
          },
          { path: 'src/a/main.ts', line: 3, column: 13, length: 3, state: STATE },
        ],
        [
          'double-click',
          async (el) => {
            const row = /** @type {HTMLElement} */ (shadow(results(el)).querySelectorAll('.acp-search-results__row')[3]);
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
          },
          { path: 'src/b.ts', line: 1, column: 3, length: 3, state: STATE },
        ],
      ]);
      for (const [name, act, detail] of cases) {
        // Arrange
        const { el } = await open({ results: RESULTS });
        const opened = collect(el, 'acp-search-dialog-open');
        const leaked = collect(el, 'acp-search-result-open');
        // Act
        await act(el);
        // Assert
        expect(opened.map((e) => e.detail), name).to.deep.equal([detail]);
        expect(opened[0].bubbles && opened[0].composed, name).to.equal(true);
        expect(leaked, name).to.deep.equal([]);
        expect(el.open, name).to.equal(false);
      }
    });
  });

  describe('states', () => {
    /** @param {AcpSearchDialog} el */
    const recentItems = (el) => /** @type {HTMLElement[]} */ ([...(shadow(el).querySelector('acp-search-recent')?.shadowRoot?.querySelectorAll('.acp-search-recent__item') ?? [])]);
    /** @param {AcpSearchDialog} el */
    const emptyAction = (el) => /** @type {HTMLElement | null} */ (shadow(el).querySelector('acp-search-empty')?.shadowRoot?.querySelector('.acp-search-empty__action') ?? null);

    it('lists recent searches for an empty query; arrows and Enter, or a click, search one', async () => {
      const cases = /** @type {[string, (el: AcpSearchDialog) => Promise<void>, string][]} */ ([
        [
          'arrow and Enter',
          async (el) => {
            press(el, 'ArrowDown');
            await el.updateComplete;
            expect(recentItems(el)[1].getAttribute('aria-selected')).to.equal('true');
            press(el, 'Enter');
          },
          'beta',
        ],
        ['click', async (el) => recentItems(el)[0].click(), 'alpha'],
      ]);
      for (const [name, act, expected] of cases) {
        // Arrange
        const { el, queries } = await open({ recent: ['alpha', 'beta'] }, { ...STATE, query: '' });
        expect(recentItems(el).map((i) => i.textContent?.trim())).to.deep.equal(['alpha', 'beta']);
        // Act
        await act(el);
        await el.updateComplete;
        // Assert
        expect(input(el).value, name).to.equal(expected);
        expect(queries.at(-1)?.detail, name).to.deep.include({ delay: 0 });
        expect(queries.at(-1)?.detail.options.query, name).to.equal(expected);
        expect(el.open, name).to.equal(true);
        el.close();
      }
    });

    it('says what is missing: no project, nothing typed, or nothing found', async () => {
      const cases = /** @type {{ name: string, props: Partial<AcpSearchDialog>, state: SearchDialogState, selector: string, contains: string[], searches: boolean }[]} */ ([
        { name: 'no project', props: { hasProject: false }, state: STATE, selector: '.acp-search-dialog__body', contains: ['Open a project first'], searches: false },
        { name: 'nothing typed', props: {}, state: { ...STATE, query: '' }, selector: '.acp-search-dialog__body', contains: ['Type to search in files'], searches: true },
        { name: 'nothing found', props: { results: [] }, state: STATE, selector: 'acp-search-empty', contains: ['No results for last', 'in src, *.ts'], searches: true },
      ]);
      for (const { name, props, state, selector, contains, searches } of cases) {
        // Arrange + Act
        const { el, queries } = await open(props, state);
        if (!searches) type(el, 'x');
        // Assert
        for (const part of contains) expect(selector === 'acp-search-empty' ? inner(el, selector) : text(el, selector), name).to.contain(part);
        if (!searches) expect(queries, `${name}: searches nothing`).to.deep.equal([]);
        el.close();
      }
    });

    it('offers to search the whole project when nothing is found; Enter opens nothing', async () => {
      const { el, queries } = await open({ results: [] });
      const opened = collect(el, 'acp-search-dialog-open');
      press(el, 'Enter');
      expect(opened).to.deep.equal([]);
      expect(el.open).to.equal(true);

      /** @type {HTMLElement} */ (emptyAction(el)).click();
      expect(queries.at(-1)?.detail.state).to.deep.include({ folder: '', mask: '' });
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: '', exclude: '' });
      await el.updateComplete;
      expect(emptyAction(el), 'no filters left to clear').to.equal(null);
    });

    it('shows progress while searching, and nothing-found only once the search is done', async () => {
      const { el } = await open({ results: [], searching: true });
      expect(shadow(el).querySelector('md-progress-linear.acp-search-dialog__progress')).to.not.equal(null);
      expect(shadow(el).querySelector('acp-search-empty')).to.equal(null);
      el.searching = false;
      await el.updateComplete;
      expect(shadow(el).querySelector('md-progress-linear')).to.equal(null);
      expect(shadow(el).querySelector('acp-search-empty')).to.not.equal(null);
    });

    it('marks a bad regex and offers to search as plain text; a bad filter only shows its message', async () => {
      const cases = /** @type {{ source: 'query' | 'filter', message: string, invalid: boolean }[]} */ ([
        { source: 'query', message: 'unclosed group', invalid: true },
        { source: 'filter', message: 'unclosed class', invalid: false },
      ]);
      for (const { source, message, invalid } of cases) {
        // Arrange + Act
        const { el, queries } = await open({ error: message, errorSource: source }, { ...STATE, regex: true });
        // Assert
        expect(input(el).getAttribute('aria-invalid'), source).to.equal(String(invalid));
        expect(inner(el, 'acp-search-empty'), source).to.contain(message);
        expect(inner(el, 'acp-search-empty').includes('Invalid regular expression'), source).to.equal(invalid);
        expect(text(el, '.acp-search-dialog__summary'), source).to.contain(message);
        const action = emptyAction(el);
        expect(action !== null, `${source}: plain-text offer`).to.equal(invalid);
        if (action) {
          // Act
          action.click();
          // Assert
          expect(queries.at(-1)?.detail.options.regex).to.equal(false);
          expect(queries.at(-1)?.detail.delay).to.equal(0);
        }
        el.close();
      }
    });
  });

  describe('header and layout', () => {
    it('turns the header’s preview and popout and the view picker’s choice into prefs and a hand-over', async () => {
      // Arrange
      const { el } = await open({ results: RESULTS, previewPosition: 'bottom', view: 'grouped' });
      const prefs = collect(el, 'acp-search-dialog-prefs');
      const popouts = collect(el, 'acp-search-dialog-popout');
      const leaked = collect(el, 'acp-search-header-preview');
      const press = (/** @type {string} */ selector, /** @type {Element} */ host) => /** @type {HTMLElement} */ (shadow(host).querySelector(selector)).click();
      // Act
      press('#acp-search-header-preview-right', header(el));
      press('#acp-search-header-preview-bottom', header(el));
      press('#acp-search-view-picker-flat', /** @type {Element} */ (shadow(el).querySelector('acp-search-view-picker')));
      type(el, 'moved');
      press('#acp-search-header-popout', header(el));
      // Assert
      expect(prefs.map((e) => e.detail)).to.deep.equal([{ patch: { preview: 'right' } }, { patch: { preview: 'none' } }, { patch: { view: 'flat' } }]);
      expect(popouts.map((e) => e.detail)).to.deep.equal([{ state: { ...STATE, query: 'moved' } }]);
      expect(leaked, 'the header’s own events stay inside').to.deep.equal([]);
      expect(el.open).to.equal(false);
      expect(el.getAttribute('preview-position')).to.equal('bottom');
      el.view = 'flat';
      await el.updateComplete;
      expect(el.getAttribute('view')).to.equal('flat');
      expect(/** @type {HTMLElementTagNameMap['acp-search-view-picker']} */ (shadow(el).querySelector('acp-search-view-picker')).view).to.equal('flat');
      expect(results(el).view).to.equal('flat');
      expect(header(el).previewPosition).to.equal('bottom');
    });
  });

  describe('filters', () => {
    /** @param {AcpSearchDialog} el */
    const filters = (el) => /** @type {HTMLElementTagNameMap['acp-search-filters']} */ (shadow(el).querySelector('acp-search-filters'));
    /**
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     */
    const chip = (el, which) => /** @type {HTMLElement} */ (shadow(filters(el)).querySelector(`.acp-search-filters__chip[data-filter="${which}"]`));
    /**
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     */
    const menu = (el, which) => /** @type {HTMLElementTagNameMap['md-menu']} */ (shadow(filters(el)).querySelector(`.acp-search-filters__menu[data-filter="${which}"]`));

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
      await until(() => menu(el, which).open);
    }

    it('shows the state’s folder and mask; a pick or a removal searches at once with the new filters', async () => {
      // Arrange
      const { el, queries } = await open();
      el.folders = [{ path: 'src/components', name: 'components', isDir: true, indices: [] }];
      expect(chip(el, 'folder').textContent?.trim()).to.equal('src');
      expect(chip(el, 'mask').textContent?.trim()).to.equal('*.ts');
      // Act: pick a folder
      await openMenu(el, 'folder');
      const item = /** @type {HTMLElement} */ (menu(el, 'folder').querySelector('md-menu-item'));
      item.dispatchEvent(new CustomEvent('select', { detail: { value: 'src/components', item }, bubbles: true, composed: true }));
      await el.updateComplete;
      // Assert
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.state.folder).to.equal('src/components');
      expect(queries.at(-1)?.detail.options.include).to.equal('src/components/**/*.ts');
      expect(queryFocused(el), 'focus back in the query').to.equal(true);
      // Act: remove the mask with its chip
      chip(el, 'mask').dispatchEvent(new Event('remove', { bubbles: true, composed: true }));
      await el.updateComplete;
      expect(queries.at(-1)?.detail.state).to.deep.include({ folder: 'src/components', mask: '' });
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: 'src/components', exclude: '' });
      expect(chip(el, 'mask').textContent?.trim()).to.equal('File mask');
    });

    it('passes the folder questions up as the dialog’s own and lists the answer', async () => {
      const { el } = await open({}, { ...STATE, folder: '' });
      const asked = collect(el, 'acp-search-dialog-folders');
      const leaked = collect(el, 'acp-search-filter-folders');
      await openMenu(el, 'folder');
      expect(asked.map((e) => e.detail)).to.deep.equal([{ query: '' }]);
      expect(leaked, 'the child’s event stays inside').to.deep.equal([]);
      el.folders = [{ path: 'src/components', name: 'components', isDir: true, indices: [] }];
      el.foldersQuery = '';
      await el.updateComplete;
      await filters(el).updateComplete;
      expect([...menu(el, 'folder').querySelectorAll('md-menu-item')].map((i) => i.getAttribute('value'))).to.deep.equal(['src/components']);
    });

    it('lets Alt+C from a menu’s field toggle the option, closes only the menu on Escape, and closes an open menu with the dialog', async () => {
      const { el, queries } = await open();
      await openMenu(el, 'mask');
      const field = /** @type {HTMLElement} */ (menu(el, 'mask').querySelector('.acp-search-filters__menu-field'));
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true, composed: true, cancelable: true }));
      expect(queries.at(-1)?.detail.options.caseSensitive).to.equal(true);
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
      await until(() => !menu(el, 'mask').open);
      expect(el.open, 'the dialog stays').to.equal(true);
      expect(queryFocused(el), 'the keys work again').to.equal(true);

      await openMenu(el, 'folder');
      const closed = new Promise((r) => dialog(el).addEventListener('close', r, { once: true }));
      el.close();
      await closed;
      await until(() => !menu(el, 'folder').open);
    });
  });
});
