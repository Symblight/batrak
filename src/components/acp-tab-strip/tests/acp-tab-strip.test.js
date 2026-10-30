import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-tab-strip.js';

/** @typedef {import('../../../models/types.js').EditorTab} EditorTab */

/**
 * @param {string} path
 * @returns {EditorTab}
 */
const fileTab = (path) => ({
  id: path,
  kind: 'file',
  path,
  content: '',
  error: '',
  loaded: false,
  image: null,
  baseline: null,
  draft: null,
  changedOnDisk: false,
  deletedOnDisk: false,
});

/**
 * @param {string} terminalId
 * @returns {EditorTab}
 */
const terminalTab = (terminalId) => ({ ...fileTab(''), id: `view:terminal:${terminalId}`, kind: 'terminal' });

/** @type {import('../../../models/types.js').TerminalInfo} */
const terminalInfo = {
  cwd: '/p',
  fallback: '/p',
  label: 'zsh — p',
  title: null,
  projectPath: '/p',
  status: 'running',
  exit: null,
  error: null,
  login: null,
};

describe('acp-tab-strip', () => {
  it('titles a terminal tab from its terminal, or the title its shell set', async () => {
    const el = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (
      await fixture(html`<acp-tab-strip .tabs=${[terminalTab('t1')]} .terminals=${{ t1: terminalInfo }}></acp-tab-strip>`)
    );
    const label = () =>
      el.shadowRoot?.querySelector('.acp-tab-strip__label')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(label()).to.include('zsh — p');
    el.terminals = { t1: { ...terminalInfo, title: 'vim a.txt' } };
    await el.updateComplete;
    expect(label()).to.include('vim a.txt');
  });

  it('asks to close a tab with its ×', async () => {
    const el = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (
      await fixture(html`<acp-tab-strip .tabs=${[fileTab('/p/a.js')]}></acp-tab-strip>`)
    );
    /** @type {unknown[]} */
    const requests = [];
    el.addEventListener('acp-tab-close-request', (e) => requests.push(/** @type {CustomEvent} */ (e).detail));
    /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('.acp-tab-strip__close')).click();
    expect(requests).to.deep.equal([{ id: '/p/a.js', scope: 'tab', ids: ['/p/a.js'] }]);
  });

  it('explains its close and unsaved marks in tooltips, not titles', async () => {
    const el = await fixture(html`<acp-tab-strip .tabs=${[{ ...fileTab('/p/a.js'), draft: 'x' }]}></acp-tab-strip>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    expect(tooltipOf(root.querySelector('.acp-tab-strip__close'))).to.equal('Close');
    expect(tooltipOf(root.querySelector('.acp-tab-strip__unsaved'))).to.equal('Unsaved changes');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it("shows a file tab's path relative to the project in its tooltip", async () => {
    const el = await fixture(html`<acp-tab-strip
      .tabs=${[fileTab('/work/app/src/main.js')]}
      .root=${'/work/app'}
    ></acp-tab-strip>`);
    expect(el.shadowRoot?.querySelector('md-tooltip')?.textContent?.trim()).to.equal('src/main.js');
  });

  it('keeps the absolute path for a file outside the project', async () => {
    const el = await fixture(html`<acp-tab-strip
      .tabs=${[fileTab('/elsewhere/notes.md')]}
      .root=${'/work/app'}
    ></acp-tab-strip>`);
    expect(el.shadowRoot?.querySelector('md-tooltip')?.textContent?.trim()).to.equal('/elsewhere/notes.md');
  });

  describe('Show Hidden Tabs', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `/p/src/file-number-${i}.js`);
    /** Lets the strip's observers measure it and the view render what they found. */
    const settle = async (/** @type {HTMLElementTagNameMap['acp-tab-strip']} */ el) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 20));
      await el.updateComplete;
    };

    /**
     * @param {{ width?: number, count?: number, active?: string, pinned?: string[], dirty?: string[] }} [props]
     */
    async function render({ width = 320, count = ids.length, active = ids[0], pinned = [], dirty = [] } = {}) {
      const tabs = ids.slice(0, count).map((id) => ({ ...fileTab(id), draft: dirty.includes(id) ? 'x' : null }));
      const el = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (
        await fixture(html`<acp-tab-strip
          style=${`width: ${width}px`}
          .tabs=${tabs}
          .active=${active}
          .pinned=${pinned}
          .root=${'/p'}
        ></acp-tab-strip>`)
      );
      await settle(el);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const strip = /** @type {HTMLElement} */ (root.querySelector('.acp-tab-strip__scroller'));
      strip.style.scrollBehavior = 'auto';
      const button = () => /** @type {HTMLElement | null} */ (root.querySelector('.acp-tab-strip__overflow'));
      const menu = () => /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('.acp-tab-strip__overflow-menu'));
      const rows = () => [...menu().querySelectorAll('.acp-tab-strip__overflow-item')];
      const listed = () => rows().map((r) => r.getAttribute('value'));
      const open = async () => {
        /** @type {HTMLElement} */ (button()).click();
        await settle(el);
      };
      /** @param {string} type */
      const listen = (type) => {
        /** @type {unknown[]} */
        const details = [];
        el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
        return details;
      };
      /** @param {string} id */
      const closeRow = (id) =>
        /** @type {HTMLElement} */ (
          menu().querySelector(`.acp-tab-strip__overflow-item[value="${CSS.escape(id)}"] .acp-tab-strip__overflow-close`)
        ).click();
      return { el, root, strip, button, menu, rows, listed, open, listen, closeRow };
    }

    it('shows no button while the tabs fit', async () => {
      const { button } = await render({ width: 900, count: 2 });
      expect(button()).to.equal(null);
    });

    it("shows the button once they don't, and lists only the tabs out of view, in strip order", async () => {
      const { button, open, menu, listed } = await render();
      expect(button()).to.exist;
      expect(button()?.getAttribute('aria-label')).to.equal('Show Hidden Tabs');
      await open();
      expect(menu().open).to.be.true;
      const hidden = listed();
      expect(hidden.length).to.be.within(1, ids.length - 1);
      expect(hidden).not.to.include(ids[0]);
      expect(hidden, 'the tail of the strip').to.deep.equal(ids.slice(ids.length - hidden.length));
    });

    it('lists the active tab selected when it is scrolled out of view', async () => {
      const { el, strip, open, rows } = await render();
      strip.scrollLeft = strip.scrollWidth;
      await settle(el);
      await open();
      const selected = rows().filter((r) => r.hasAttribute('selected'));
      expect(selected.map((r) => r.getAttribute('value'))).to.deep.equal([ids[0]]);
      expect(rows()[0].getAttribute('value')).to.equal(ids[0]);
    });

    it('activates a picked row and closes the menu', async () => {
      const { el, open, rows, menu, listen } = await render();
      await open();
      const activations = listen('acp-tab-activate');
      const row = rows()[0];
      /** @type {HTMLElement} */ (row.shadowRoot?.querySelector('.md-menu-item__interactive')).click();
      await settle(el);
      expect(activations).to.deep.equal([{ id: row.getAttribute('value') }]);
      expect(menu().open).to.be.false;
    });

    it("closes a row's tab with its ×, keeping the menu open", async () => {
      const { el, open, listed, menu, listen, closeRow } = await render();
      await open();
      const closes = listen('acp-tab-close-request');
      const activations = listen('acp-tab-activate');
      const id = /** @type {string} */ (listed().at(-1));
      closeRow(id);
      await settle(el);
      expect(closes).to.deep.equal([{ id, scope: 'tab', ids: [id] }]);
      expect(activations).to.deep.equal([]);
      expect(menu().open).to.be.true;
    });

    it("unpins a pinned row's tab with its pin", async () => {
      const { el, strip, open, menu, listen, closeRow } = await render({ pinned: [ids[0]], active: ids[5] });
      strip.scrollLeft = strip.scrollWidth;
      await settle(el);
      await open();
      const pins = listen('acp-tab-pin');
      closeRow(ids[0]);
      await settle(el);
      expect(pins).to.deep.equal([{ id: ids[0], pinned: false }]);
      expect(menu().open).to.be.true;
    });

    it('closes a row with Delete', async () => {
      const { el, open, rows, listen } = await render();
      await open();
      const closes = listen('acp-tab-close-request');
      const row = rows()[0];
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true }));
      await settle(el);
      const id = row.getAttribute('value');
      expect(closes).to.deep.equal([{ id, scope: 'tab', ids: [id] }]);
    });

    it('closes the menu with Escape', async () => {
      const { el, open, menu } = await render();
      await open();
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(el);
      expect(menu().open).to.be.false;
    });
  });

});
