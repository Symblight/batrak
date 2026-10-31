import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../tab-strip.js';

/** @typedef {import('../../../models/types/types.js').EditorTab} EditorTab */

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

/** @type {import('../../../models/types/types.js').TerminalInfo} */
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
  it('shows a file tab with its file\'s icon and a view tab with its own', async () => {
    const el = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (
      await fixture(
        html`<acp-tab-strip .tabs=${[fileTab('/p/src/main.rs'), terminalTab('t1')]} .terminals=${{ t1: terminalInfo }}></acp-tab-strip>`,
      )
    );
    const labels = [...(el.shadowRoot?.querySelectorAll('.acp-tab-strip__label') ?? [])];
    expect(labels.map((l) => l.querySelector('acp-file-icon')?.getAttribute('name') ?? null)).to.deep.equal(['main.rs', null]);
    expect(labels[1].querySelector('md-icon')).to.not.equal(null);
  });

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

  it('asks to close a tab with its ×, and explains its close and unsaved marks in tooltips, not titles', async () => {
    // Arrange
    const el = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (
      await fixture(html`<acp-tab-strip .tabs=${[{ ...fileTab('/p/a.js'), draft: 'x' }]}></acp-tab-strip>`)
    );
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {unknown[]} */
    const requests = [];
    el.addEventListener('acp-tab-close-request', (e) => requests.push(/** @type {CustomEvent} */ (e).detail));
    // Act
    /** @type {HTMLElement} */ (root.querySelector('.acp-tab-strip__close')).click();
    // Assert
    expect(requests).to.deep.equal([{ id: '/p/a.js', scope: 'tab', ids: ['/p/a.js'] }]);
    expect(tooltipOf(root.querySelector('.acp-tab-strip__close'))).to.equal('Close');
    expect(tooltipOf(root.querySelector('.acp-tab-strip__unsaved'))).to.equal('Unsaved changes');
    expect(root.querySelector('[title]')).to.equal(null);
  });

  it("shows a file tab's path in its tooltip: relative inside the project, absolute outside it", async () => {
    const cases = [
      ['/work/app/src/main.js', 'src/main.js'],
      ['/elsewhere/notes.md', '/elsewhere/notes.md'],
    ];
    for (const [path, expected] of cases) {
      // Arrange
      const el = await fixture(html`<acp-tab-strip .tabs=${[fileTab(path)]} .root=${'/work/app'}></acp-tab-strip>`);
      // Assert
      expect(el.shadowRoot?.querySelector('md-tooltip')?.textContent?.trim(), path).to.equal(expected);
    }
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

    it("shows no button while the tabs fit, and once they don't lists only the tabs out of view, in strip order", async () => {
      // Arrange
      const fits = await render({ width: 900, count: 2 });
      expect(fits.button(), 'while they fit').to.equal(null);
      const { button, open, menu, listed } = await render();
      // Act
      await open();
      // Assert
      expect(button()?.getAttribute('aria-label')).to.equal('Show Hidden Tabs');
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

    it("closes a row's tab with its ×, or unpins a pinned row's tab with its pin, keeping the menu open", async () => {
      // Arrange
      const plain = await render();
      await plain.open();
      const closes = plain.listen('acp-tab-close-request');
      const activations = plain.listen('acp-tab-activate');
      const id = /** @type {string} */ (plain.listed().at(-1));
      // Act
      plain.closeRow(id);
      await settle(plain.el);
      // Assert
      expect(closes).to.deep.equal([{ id, scope: 'tab', ids: [id] }]);
      expect(activations).to.deep.equal([]);
      expect(plain.menu().open).to.be.true;

      // Arrange
      const { el, strip, open, menu, listen, closeRow } = await render({ pinned: [ids[0]], active: ids[5] });
      strip.scrollLeft = strip.scrollWidth;
      await settle(el);
      await open();
      const pins = listen('acp-tab-pin');
      // Act
      closeRow(ids[0]);
      await settle(el);
      // Assert
      expect(pins).to.deep.equal([{ id: ids[0], pinned: false }]);
      expect(menu().open).to.be.true;
    });

    it('closes a row with Delete and the menu with Escape', async () => {
      // Arrange
      const { el, open, rows, listen, menu } = await render();
      await open();
      const closes = listen('acp-tab-close-request');
      const row = rows()[0];
      const id = row.getAttribute('value');
      // Act
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true }));
      await settle(el);
      // Assert
      expect(closes).to.deep.equal([{ id, scope: 'tab', ids: [id] }]);
      expect(menu().open, 'Delete keeps the menu').to.be.true;
      // Act
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(el);
      // Assert
      expect(menu().open).to.be.false;
    });
  });

  describe('dragging tabs', () => {
    const ids = ['/p/a.js', '/p/b.js', '/p/c.js', '/p/d.js', '/p/e.js'];

    /**
     * @param {{ width?: number, count?: number, pinned?: string[] }} [props]
     */
    async function render({ width = 900, count = 4, pinned = [] } = {}) {
      const el = /** @type {HTMLElementTagNameMap['acp-tab-strip']} */ (
        await fixture(html`<acp-tab-strip
          style=${`width: ${width}px`}
          .tabs=${ids.slice(0, count).map(fileTab)}
          .active=${ids[0]}
          .pinned=${pinned}
          .root=${'/p'}
        ></acp-tab-strip>`)
      );
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await el.updateComplete;
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const strip = /** @type {HTMLElement} */ (root.querySelector('.acp-tab-strip__scroller'));
      strip.style.scrollBehavior = 'auto';
      /** @param {string} id */
      const tab = (id) => /** @type {HTMLElement} */ (root.querySelector(`.acp-tab-strip__tab[value="${CSS.escape(id)}"]`));
      /** @param {string} id */
      const label = (id) => /** @type {HTMLElement} */ (tab(id).querySelector('.acp-tab-strip__label'));
      /** @param {string} id */
      const center = (id) => {
        const r = tab(id).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      /** @param {string} type */
      const listen = (type) => {
        /** @type {unknown[]} */
        const details = [];
        el.addEventListener(type, (e) => details.push(/** @type {CustomEvent} */ (e).detail));
        return details;
      };
      /** The pressed tab's label: where the press started, as a real pointer would keep sending to. */
      /** @type {HTMLElement | null} */
      let pressed = null;
      /**
       * @param {string} type
       * @param {number} x
       * @param {number} y
       * @param {{ button?: number }} [init]
       */
      const send = (type, x, y, { button = 0 } = {}) =>
        /** @type {HTMLElement} */ (pressed).dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            composed: true,
            cancelable: true,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : button,
            buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 << [0, 2, 1][button],
            clientX: x,
            clientY: y,
          }),
        );
      /**
       * @param {string} id
       * @param {{ button?: number }} [init]
       */
      const press = (id, init) => {
        pressed = label(id);
        const { x, y } = center(id);
        send('pointerdown', x, y, init);
        return { x, y };
      };
      /** Moves in small steps, as a real pointer does. */
      const moveTo = async (/** @type {number} */ x, /** @type {number} */ y) => {
        send('pointermove', x, y);
        await el.updateComplete;
      };
      const release = async (/** @type {number} */ x, /** @type {number} */ y) => {
        send('pointerup', x, y);
        await el.updateComplete;
      };
      /**
       * Drags `id` to `x` (and `y`, the tabs' row by default) and drops it there.
       * @param {string} id
       * @param {number} x
       * @param {number} [y]
       */
      const drag = async (id, x, y) => {
        const start = press(id);
        await moveTo(start.x + Math.sign(x - start.x) * 10, start.y);
        await moveTo(x, y ?? start.y);
        await release(x, y ?? start.y);
      };
      const dragging = () => [...root.querySelectorAll('.acp-tab-strip__tab_dragging')].map((t) => t.getAttribute('value'));
      return { el, root, strip, tab, label, center, listen, press, moveTo, release, drag, dragging };
    }

    it('moves a tab to the index its pointer crossed, keeping unpinned tabs after the pinned ones', async () => {
      /** @type {[string, { count?: number, pinned?: string[] }, number, (h: Awaited<ReturnType<typeof render>>) => number, number | null][]} */
      const cases = [
        // [why, props, dragged, x to drop at, expected index (null: no move)]
        ['forward past the midpoints crossed', {}, 0, (h) => h.center(ids[2]).x + 5, 2],
        ['backward', {}, 3, (h) => h.center(ids[1]).x - 5, 1],
        ['an unpinned tab stays after the pinned ones', { count: 5, pinned: [ids[0], ids[1]] }, 4, (h) => h.tab(ids[0]).getBoundingClientRect().left + 2, 2],
        ['a pinned tab stays among the pinned ones', { count: 4, pinned: [ids[0], ids[1]] }, 0, (h) => h.tab(ids[3]).getBoundingClientRect().right - 2, 1],
        ['dropped where it was', {}, 1, (h) => h.center(ids[1]).x + 6, null],
      ];
      for (const [why, props, dragged, dropX, index] of cases) {
        // Arrange
        const h = await render(props);
        const moves = h.listen('acp-tab-move');
        // Act
        await h.drag(ids[dragged], dropX(h));
        // Assert
        expect(moves, why).to.deep.equal(index === null ? [] : [{ id: ids[dragged], index }]);
      }
    });

    it('does not move a tab dropped outside the strip', async () => {
      const { strip, center, listen, drag } = await render();
      const moves = listen('acp-tab-move');
      await drag(ids[0], center(ids[2]).x + 5, strip.getBoundingClientRect().bottom + 80);
      expect(moves).to.deep.equal([]);
    });

    it('marks the dragged tab only while it is dragged', async () => {
      const { center, press, moveTo, release, dragging } = await render();
      const start = press(ids[1]);
      expect(dragging(), 'a press alone').to.deep.equal([]);
      await moveTo(start.x + 10, start.y);
      expect(dragging()).to.deep.equal([ids[1]]);
      await moveTo(center(ids[3]).x, start.y);
      await release(center(ids[3]).x, start.y);
      expect(dragging()).to.deep.equal([]);
    });

    it('activates a clicked tab without moving it, but not a dropped one', async () => {
      const { el, center, label, listen, press, release, drag } = await render();
      const moves = listen('acp-tab-move');
      const activations = listen('acp-tab-activate');
      const at = press(ids[1]);
      await release(at.x + 1, at.y);
      label(ids[1]).click();
      await el.updateComplete;
      expect(activations).to.deep.equal([{ id: ids[1] }]);

      await drag(ids[2], center(ids[3]).x + 5);
      label(ids[2]).click(); // the click that follows the release
      await el.updateComplete;
      expect(moves).to.deep.equal([{ id: ids[2], index: 3 }]);
      expect(activations, 'the drop is no click').to.deep.equal([{ id: ids[1] }]);
      await new Promise((r) => setTimeout(r));
      label(ids[2]).click();
      expect(activations, 'a later click').to.deep.equal([{ id: ids[1] }, { id: ids[2] }]);
    });

    it('does not drag with the middle button', async () => {
      const { center, press, moveTo, release, listen, dragging } = await render();
      const moves = listen('acp-tab-move');
      const at = press(ids[0], { button: 1 });
      await moveTo(center(ids[2]).x + 5, at.y);
      expect(dragging()).to.deep.equal([]);
      await release(center(ids[2]).x + 5, at.y);
      expect(moves).to.deep.equal([]);
    });

    it('ends a press whose release it missed once the pointer moves with no button held', async () => {
      const { el, label, center, press, drag, listen, dragging } = await render();
      const moves = listen('acp-tab-move');
      const at = press(ids[0]);
      const hover = new PointerEvent('pointermove', {
        bubbles: true,
        composed: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: -1,
        buttons: 0,
        clientX: center(ids[2]).x + 5,
        clientY: at.y,
      });
      label(ids[0]).dispatchEvent(hover);
      await el.updateComplete;
      expect(dragging(), 'a hover is no drag').to.deep.equal([]);
      expect(moves).to.deep.equal([]);
      await drag(ids[1], center(ids[3]).x + 5);
      expect(moves, 'a new press drags as usual').to.deep.equal([{ id: ids[1], index: 3 }]);
    });

    it('cancels a drag with Escape', async () => {
      const { el, center, press, moveTo, release, listen, dragging } = await render();
      const moves = listen('acp-tab-move');
      const at = press(ids[0]);
      await moveTo(at.x + 10, at.y);
      await moveTo(center(ids[2]).x + 5, at.y);
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
      document.body.dispatchEvent(escape);
      await el.updateComplete;
      expect(escape.defaultPrevented).to.be.true;
      expect(dragging()).to.deep.equal([]);
      await moveTo(center(ids[3]).x + 5, at.y);
      expect(dragging(), 'the rest of the press').to.deep.equal([]);
      await release(center(ids[3]).x + 5, at.y);
      expect(moves).to.deep.equal([]);
    });

    it('scrolls the strip while the pointer is near its edge, and lands among the tabs scrolled in', async () => {
      const { el, strip, press, moveTo, release, listen } = await render({ width: 260, count: 5 });
      expect(strip.scrollWidth).to.be.greaterThan(strip.clientWidth);
      const moves = listen('acp-tab-move');
      const at = press(ids[0]);
      const edge = strip.getBoundingClientRect().right - 4;
      await moveTo(at.x + 10, at.y);
      await moveTo(edge, at.y);
      for (let i = 0; i < 60 && strip.scrollLeft < strip.scrollWidth - strip.clientWidth; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      expect(strip.scrollLeft).to.be.greaterThan(0);
      await el.updateComplete;
      await release(edge, at.y);
      expect(moves).to.deep.equal([{ id: ids[0], index: 4 }]);
    });
  });
});
