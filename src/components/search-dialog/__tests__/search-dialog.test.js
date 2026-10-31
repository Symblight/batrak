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
        else /** @type {HTMLElement} */ (shadow(el).querySelectorAll('.acp-search-dialog__layout-button')[2]).click();
        await closed;
        expect(document.activeElement, action).to.equal(target);
        before.remove();
        target.remove();
      }
    });

    it('closes on a click on the scrim, not inside and not when a selection drag from the input ends there', async () => {
      const { el } = await open();
      const header = /** @type {HTMLElement} */ (shadow(el).querySelector('.acp-search-dialog__header'));
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      header.click();
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
      expect(shadow(el).activeElement).to.equal(input(el));
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
    it('lists recent searches for an empty query; arrows and Enter, or a click, search one', async () => {
      const cases = /** @type {[string, (el: AcpSearchDialog) => Promise<void>, string][]} */ ([
        [
          'arrow and Enter',
          async (el) => {
            press(el, 'ArrowDown');
            await el.updateComplete;
            expect(shadow(el).querySelectorAll('.acp-search-dialog__recent-item')[1].getAttribute('aria-selected')).to.equal('true');
            press(el, 'Enter');
          },
          'beta',
        ],
        ['click', async (el) => /** @type {HTMLElement} */ (shadow(el).querySelectorAll('.acp-search-dialog__recent-item')[0]).click(), 'alpha'],
      ]);
      for (const [name, act, expected] of cases) {
        // Arrange
        const { el, queries } = await open({ recent: ['alpha', 'beta'] }, { ...STATE, query: '' });
        const items = [...shadow(el).querySelectorAll('.acp-search-dialog__recent-item')];
        expect(text(el, '.acp-search-dialog__heading')).to.equal('Recent searches');
        expect(items.map((i) => i.textContent?.trim())).to.deep.equal(['alpha', 'beta']);
        expect(items[0].getAttribute('aria-selected')).to.equal('true');
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
        { name: 'nothing found', props: { results: [] }, state: STATE, selector: '.acp-search-dialog__empty', contains: ['No results for last', 'in src, *.ts'], searches: true },
      ]);
      for (const { name, props, state, selector, contains, searches } of cases) {
        // Arrange + Act
        const { el, queries } = await open(props, state);
        if (!searches) type(el, 'x');
        // Assert
        for (const part of contains) expect(text(el, selector), name).to.contain(part);
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

      /** @type {HTMLElement} */ (shadow(el).querySelector('.acp-search-dialog__empty-action')).click();
      expect(queries.at(-1)?.detail.state).to.deep.include({ folder: '', mask: '' });
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: '', exclude: '' });
      await el.updateComplete;
      expect(shadow(el).querySelector('.acp-search-dialog__empty-action'), 'no filters left to clear').to.equal(null);
    });

    it('shows progress while searching, and nothing-found only once the search is done', async () => {
      const { el } = await open({ results: [], searching: true });
      expect(shadow(el).querySelector('md-progress-linear.acp-search-dialog__progress')).to.not.equal(null);
      expect(shadow(el).querySelector('.acp-search-dialog__empty')).to.equal(null);
      el.searching = false;
      await el.updateComplete;
      expect(shadow(el).querySelector('md-progress-linear')).to.equal(null);
      expect(shadow(el).querySelector('.acp-search-dialog__empty')).to.not.equal(null);
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
        expect(text(el, '.acp-search-dialog__empty'), source).to.contain(message);
        expect(text(el, '.acp-search-dialog__empty'), source).to.satisfy((/** @type {string} */ t) => t.includes('Invalid regular expression') === invalid);
        expect(text(el, '.acp-search-dialog__summary'), source).to.contain(message);
        const action = /** @type {HTMLElement | null} */ (shadow(el).querySelector('.acp-search-dialog__empty-action'));
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
    /** @param {AcpSearchDialog} el */
    const buttons = (el) => /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-dialog__layout-button')]);
    /** @param {AcpSearchDialog} el */
    const viewButtons = (el) => /** @type {HTMLElement[]} */ ([...shadow(el).querySelectorAll('.acp-search-dialog__view-button')]);

    it('names its buttons in tooltips, not titles, and shows an icon on each, pressed or not', async () => {
      const { el } = await open({ results: RESULTS, previewPosition: 'bottom', view: 'grouped' });
      expect(text(el, '.acp-search-dialog__title')).to.equal('Search in files');
      expect(buttons(el).map(tooltipOf)).to.deep.equal(['Preview below', 'Preview on the right', 'Open in panel']);
      expect(viewButtons(el).map(tooltipOf)).to.deep.equal(['Group by file', 'Flat list']);
      expect(shadow(el).querySelector('[title]')).to.equal(null);
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
     * Types into a menu's field.
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     * @param {string} value
     */
    function typeIn(el, which, value) {
      field(el, which).value = value;
      field(el, which).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    /**
     * A key in a menu's field.
     * @param {AcpSearchDialog} el
     * @param {'folder' | 'mask'} which
     * @param {string} key
     * @param {KeyboardEventInit} [init]
     */
    function keyIn(el, which, key, init = {}) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init });
      field(el, which).dispatchEvent(event);
      return event;
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

    it('clears a filter with its remove button, closing its open menu, and searches at once', async () => {
      const { el, queries } = await open();
      await openMenu(el, 'folder');
      chip(el, 'folder').dispatchEvent(new Event('remove', { bubbles: true, composed: true }));
      await el.updateComplete;
      expect(queries.at(-1)?.detail).to.deep.include({ delay: 0 });
      expect(queries.at(-1)?.detail.state).to.deep.include({ folder: '', mask: '*.ts' });
      expect(queries.at(-1)?.detail.options).to.deep.include({ include: '**/*.ts', exclude: '' });
      expect(chip(el, 'folder').localName).to.equal('md-filter-chip');
      await until(() => !menu(el, 'folder').open);
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
      keyIn(el, 'mask', 'Enter');
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

    it("keeps typing in a menu's field instead of jumping to an item, and lets Alt+C through", async () => {
      const { el, queries } = await open();
      await openMenu(el, 'mask');
      field(el, 'mask').focus();
      const key = keyIn(el, 'mask', 'c');
      expect(key.defaultPrevented).to.equal(false);
      expect(shadow(el).activeElement).to.equal(field(el, 'mask'));
      keyIn(el, 'mask', 'ç', { code: 'KeyC', altKey: true });
      expect(queries.at(-1)?.detail.options.caseSensitive).to.equal(true);
    });

    it('closes only the menu on Escape in its field, not while an IME composes', async () => {
      const { el } = await open();
      await openMenu(el, 'mask');
      field(el, 'mask').focus();
      keyIn(el, 'mask', 'Escape', { isComposing: true });
      await el.updateComplete;
      await menu(el, 'mask').updateComplete;
      expect(menu(el, 'mask').open, 'composing').to.equal(true);
      keyIn(el, 'mask', 'Escape');
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
      const components = [{ path: 'src/components', name: 'components', isDir: true, indices: [] }];
      // A string types into the field; an object answers a folder query, as <acp-app> does.
      const cases = /** @type {[string, (string | { answers: string })[], string][]} */ ([
        ['an empty field picks nothing', [], ''],
        ['a list for older typing picks nothing', ['comp'], ''],
        ['a late answer to an older query picks nothing', ['co', 'comp', { answers: 'co' }], ''],
        ['the answer to the latest query picks', ['comp', { answers: 'comp' }], 'src/components'],
        ['a repeated list for the latest query picks', ['comp', { answers: 'comp' }, 'compo', { answers: 'compo' }], 'src/components'],
      ]);
      for (const [name, steps, expected] of cases) {
        // Arrange
        const { el, queries } = await open({}, { ...STATE, folder: '' });
        el.folders = [{ path: 'old', name: 'old', isDir: true, indices: [] }];
        await openMenu(el, 'folder');
        for (const step of steps) {
          if (typeof step === 'string') typeIn(el, 'folder', step);
          else {
            el.folders = components;
            el.foldersQuery = step.answers;
            await el.updateComplete;
          }
        }
        // Act
        keyIn(el, 'folder', 'Enter');
        // Assert
        expect(queries.at(-1)?.detail.state.folder, name).to.equal(expected);
        el.close();
      }
    });
  });
});
