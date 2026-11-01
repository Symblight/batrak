import { expect, fixture, html } from '../../../../test/fixture.js';
import '../search-filters.js';

/** @typedef {import('../search-filters.js').AcpSearchFilters} AcpSearchFilters */

/** @type {'folder' | 'mask'} */
const FOLDER = 'folder';

const COMPONENTS = [{ path: 'src/components', name: 'components', isDir: true, indices: [] }];

/** @param {AcpSearchFilters} el */
const shadow = (el) => /** @type {ShadowRoot} */ (el.shadowRoot);
/**
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 */
const chip = (el, which) => /** @type {HTMLElement} */ (shadow(el).querySelector(`.acp-search-filters__chip[data-filter="${which}"]`));
/**
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 */
const menu = (el, which) => /** @type {HTMLElementTagNameMap['md-menu']} */ (shadow(el).querySelector(`.acp-search-filters__menu[data-filter="${which}"]`));
/**
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 */
const field = (el, which) => /** @type {HTMLElementTagNameMap['md-text-field']} */ (menu(el, which).querySelector('.acp-search-filters__menu-field'));

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

/** @param {Partial<AcpSearchFilters>} [props] */
async function render(props = {}) {
  const el = /** @type {AcpSearchFilters} */ (await fixture(html`<acp-search-filters></acp-search-filters>`));
  Object.assign(el, props);
  await el.updateComplete;
  return el;
}

/**
 * Opens a chip's menu and waits for it.
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 */
async function openMenu(el, which) {
  chip(el, which).click();
  await el.updateComplete;
  await until(() => menu(el, which).open);
}

/**
 * Picks a menu item as a click would.
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 * @param {string} value
 */
function pick(el, which, value) {
  const item = /** @type {HTMLElement} */ (menu(el, which).querySelector(`md-menu-item[value="${CSS.escape(value)}"]`));
  item.dispatchEvent(new CustomEvent('select', { detail: { value, item }, bubbles: true, composed: true }));
}

/**
 * Types into a menu's field.
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 * @param {string} value
 */
function typeIn(el, which, value) {
  field(el, which).value = value;
  field(el, which).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

/**
 * A key in a menu's field.
 * @param {AcpSearchFilters} el
 * @param {'folder' | 'mask'} which
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function keyIn(el, which, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init });
  field(el, which).dispatchEvent(event);
  return event;
}

describe('acp-search-filters', () => {
  it('shows an unset filter as a filter chip and a set one as a removable input chip', async () => {
    const unset = await render();
    expect(chip(unset, FOLDER).localName).to.equal('md-filter-chip');
    expect(chip(unset, FOLDER).textContent?.trim()).to.equal('Folder');
    expect(chip(unset, 'mask').localName).to.equal('md-filter-chip');
    expect(chip(unset, 'mask').textContent?.trim()).to.equal('File mask');

    const set = await render({ folder: 'src', mask: '*.ts' });
    expect(chip(set, FOLDER).localName).to.equal('md-input-chip');
    expect(chip(set, FOLDER).textContent?.trim()).to.equal('src');
    expect(chip(set, 'mask').textContent?.trim()).to.equal('*.ts');
  });

  it('clears a filter with its remove button, closing its open menu and handing focus back', async () => {
    const el = await render({ folder: 'src' });
    const changes = collect(el, 'acp-search-filter-change');
    const leaves = collect(el, 'acp-search-filter-leave');
    await openMenu(el, FOLDER);
    chip(el, FOLDER).dispatchEvent(new Event('remove', { bubbles: true, composed: true }));
    expect(changes.map((e) => e.detail)).to.deep.equal([{ which: 'folder', value: '' }]);
    expect(leaves.length).to.equal(1);
    await until(() => !menu(el, FOLDER).open);
  });

  it("asks for the project's folders as the folder menu opens and as its field is typed in", async () => {
    const el = await render();
    const asked = collect(el, 'acp-search-filter-folders');
    await openMenu(el, FOLDER);
    expect(asked.map((e) => e.detail)).to.deep.equal([{ query: '' }]);
    typeIn(el, FOLDER, 'comp');
    expect(asked.map((e) => e.detail)).to.deep.equal([{ query: '' }, { query: 'comp' }]);
  });

  it('lists the folders with the current one checked; a pick sets it and hands focus back', async () => {
    const el = await render({
      folder: 'src',
      folders: [{ path: 'src', name: 'src', isDir: true, indices: [] }, ...COMPONENTS],
    });
    const changes = collect(el, 'acp-search-filter-change');
    const leaves = collect(el, 'acp-search-filter-leave');
    const leaked = collect(el, 'select');
    await openMenu(el, FOLDER);
    const items = [...menu(el, FOLDER).querySelectorAll('md-menu-item')];
    expect(items.map((i) => i.getAttribute('value'))).to.deep.equal(['src', 'src/components']);
    expect(items.map((i) => i.hasAttribute('selected'))).to.deep.equal([true, false]);
    pick(el, FOLDER, 'src/components');
    expect(leaked, "the menu's select stays inside").to.deep.equal([]);
    expect(changes.map((e) => e.detail)).to.deep.equal([{ which: 'folder', value: 'src/components' }]);
    expect(leaves.length).to.equal(1);
  });

  it('sets the mask by typing it and pressing Enter (trimmed; typing alone sets nothing) or by picking a preset', async () => {
    const el = await render();
    const changes = collect(el, 'acp-search-filter-change');
    await openMenu(el, 'mask');
    const presets = [...menu(el, 'mask').querySelectorAll('md-menu-item')].map((i) => i.getAttribute('value'));
    expect(presets).to.deep.equal(['*.{js,ts}', '*.css', '*.md', '!*.test.js', '!pnpm-lock.yaml']);
    typeIn(el, 'mask', ' *.ts, !*.test.ts ');
    expect(changes, 'typing alone sets nothing').to.deep.equal([]);
    keyIn(el, 'mask', 'Enter');
    await until(() => !menu(el, 'mask').open);
    await openMenu(el, 'mask');
    pick(el, 'mask', '*.css');
    expect(changes.map((e) => e.detail)).to.deep.equal([
      { which: 'mask', value: '*.ts, !*.test.ts' },
      { which: 'mask', value: '*.css' },
    ]);
  });

  it("keeps typing in a menu's field instead of jumping to an item, and lets Alt+C through", async () => {
    const el = await render();
    await openMenu(el, 'mask');
    field(el, 'mask').focus();
    const heard = collect(el, 'keydown');
    keyIn(el, 'mask', 'c');
    expect(heard.length, 'plain typing stays in the field').to.equal(0);
    expect(shadow(el).activeElement).to.equal(field(el, 'mask'));
    keyIn(el, 'mask', 'ç', { code: 'KeyC', altKey: true });
    expect(heard.length, 'Alt+C goes on to the dialog').to.equal(1);
  });

  it('closes only the menu on Escape, not while an IME composes, handing focus back; closeOpenMenu and closeMenus close what is open', async () => {
    const el = await render();
    const leaves = collect(el, 'acp-search-filter-leave');
    expect(el.closeOpenMenu(), 'none open').to.equal(false);
    await openMenu(el, 'mask');
    field(el, 'mask').focus();
    keyIn(el, 'mask', 'Escape', { isComposing: true });
    await menu(el, 'mask').updateComplete;
    expect(menu(el, 'mask').open, 'composing').to.equal(true);
    keyIn(el, 'mask', 'Escape');
    await until(() => !menu(el, 'mask').open);
    expect(leaves.length, 'focus handed back').to.be.greaterThan(0);

    await openMenu(el, 'mask');
    expect(el.closeOpenMenu()).to.equal(true);
    await until(() => !menu(el, 'mask').open);
    await openMenu(el, FOLDER);
    el.closeMenus();
    await until(() => !menu(el, FOLDER).open);
  });

  it('picks the first folder on Enter only from a list that answers the latest typing', async () => {
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
      const el = await render({ folders: [{ path: 'old', name: 'old', isDir: true, indices: [] }] });
      const changes = collect(el, 'acp-search-filter-change');
      await openMenu(el, FOLDER);
      for (const step of steps) {
        if (typeof step === 'string') typeIn(el, FOLDER, step);
        else {
          el.folders = COMPONENTS;
          el.foldersQuery = step.answers;
          await el.updateComplete;
        }
      }
      // Act
      keyIn(el, FOLDER, 'Enter');
      // Assert
      expect(changes.at(-1)?.detail.value ?? '', name).to.equal(expected);
    }
  });
});
