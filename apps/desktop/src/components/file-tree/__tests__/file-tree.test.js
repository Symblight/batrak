import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../file-tree.js';

/** @typedef {import('../../../hooks/projects/types.js').RootEntry} RootEntry */
/** @typedef {HTMLElementTagNameMap['acp-file-tree']} AcpFileTree */

/**
 * @param {string} path
 * @param {boolean} isDir
 * @returns {RootEntry}
 */
const entry = (path, isDir) => ({ name: path.split('/').pop() ?? path, path, isDir, ignored: false });

/** @type {Record<string, RootEntry[]>} */
const LISTING = { '': [entry('src', true), entry('a.txt', false)], src: [entry('src/x.js', false)] };

/** @param {string} _rootId @param {string} rel */
const listDir = async (_rootId, rel) => LISTING[rel] ?? [];

/** @param {() => boolean} condition */
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).to.equal(true);
}

/** @param {AcpFileTree} el */
const treeOf = (el) => /** @type {HTMLElementTagNameMap['tvx-tree-view']} */ (el.shadowRoot?.querySelector('tvx-tree-view'));

describe('acp-file-tree', () => {
  /** @type {OnErrorEventHandler} */
  let onerror = null;
  // The virtualized rows resize as they render: a browser notice, not an error of the tree.
  before(() => {
    onerror = window.onerror;
    window.onerror = (message, ...rest) => (String(message).includes('ResizeObserver loop') ? true : onerror?.(message, ...rest));
  });
  after(() => {
    window.onerror = onerror;
  });

  describe('context menu', () => {
    /**
     * Right-clicks a row.
     * @param {AcpFileTree} el
     * @param {string} id
     */
    async function rightClick(el, id) {
      const label = () => treeOf(el).shadowRoot?.getElementById(`acp-file-tree-label:${id}`);
      await until(() => Boolean(label()));
      label()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2, clientX: 40, clientY: 40 }));
      const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (el.shadowRoot?.querySelector('md-menu'));
      await until(() => menu.open);
      return menu;
    }

    /**
     * Picks an item: md-menu repeats a submenu's pick, with the item's own detail.
     * @param {HTMLElementTagNameMap['md-menu']} menu
     * @param {string} value
     */
    function pick(menu, value) {
      const item = menu.querySelector(`md-menu-item[value="${value}"]`);
      expect(item, value).to.not.equal(null);
      const detail = { value, item };
      menu.dispatchEvent(new CustomEvent('select', { detail }));
      menu.dispatchEvent(new CustomEvent('select', { detail }));
    }

    const CASES = [
      { row: 'a.txt', value: 'reveal', event: 'acp-reveal-path', detail: { path: '/p/a.txt' } },
      { row: 'src', value: 'reveal', event: 'acp-reveal-path', detail: { path: '/p/src' } },
      { row: 'a.txt', value: 'open-terminal', event: 'acp-open-terminal', detail: { path: '/p' } },
      { row: 'src', value: 'open-terminal', event: 'acp-open-terminal', detail: { path: '/p/src' } },
      { row: 'a.txt', value: 'copy-path', event: 'acp-copy', detail: { text: '/p/a.txt' } },
    ];
    for (const { row, value, event, detail } of CASES) {
      it(`${value} on ${row} asks once for ${JSON.stringify(detail)}`, async () => {
        // Arrange
        /** @type {AcpFileTree} */
        const el = await fixture(html`<acp-file-tree .rootId=${'root-menu'} .root=${'/p'} .listDir=${listDir}></acp-file-tree>`);
        /** @type {unknown[]} */
        const fired = [];
        el.addEventListener(event, (e) => fired.push(/** @type {CustomEvent} */ (e).detail));
        // Act
        pick(await rightClick(el, row), value);
        // Assert
        expect(fired).to.deep.equal([detail]);
      });
    }

    it('names the file manager of the OS, and a right-click neither opens the file nor selects the row', async () => {
      // Arrange
      /** @type {AcpFileTree} */
      const el = await fixture(html`<acp-file-tree .rootId=${'root-menu'} .root=${'/p'} .listDir=${listDir} .platform=${'windows'}></acp-file-tree>`);
      let opened = 0;
      el.addEventListener('acp-file-open', () => opened++);
      // Act
      const menu = await rightClick(el, 'a.txt');
      // Assert
      expect(menu.querySelector('md-menu-item[value="reveal"]')?.textContent?.trim()).to.equal('Explorer');
      expect(opened).to.equal(0);
      expect([...treeOf(el).selection.get()]).to.deep.equal([]);
    });

    it('leaves a right-click on the empty space alone', async () => {
      // Arrange
      /** @type {AcpFileTree} */
      const el = await fixture(html`<acp-file-tree .rootId=${'root-menu'} .root=${'/p'} .listDir=${listDir}></acp-file-tree>`);
      await until(() => treeOf(el).nodes.getChildIds().length > 0);
      const click = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2 });
      // Act
      treeOf(el).dispatchEvent(click);
      await el.updateComplete;
      // Assert
      expect(click.defaultPrevented).to.equal(false);
      expect(el.shadowRoot?.querySelector('md-menu')?.open).to.equal(false);
    });
  });

  it('asks for a project only while there is none, not while one is on its way', async () => {
    const cases = [
      // [root, opening, shown, why]
      [null, false, true, 'no project'],
      [null, true, false, 'the first project is opening'],
      ['/p', false, false, 'a restored project whose root is not open yet'],
    ];
    for (const [root, opening, shown, why] of /** @type {[string | null, boolean, boolean, string][]} */ (cases)) {
      // Arrange + Act
      const el = /** @type {AcpFileTree} */ (await fixture(html`<acp-file-tree .root=${root} .opening=${opening}></acp-file-tree>`));

      // Assert
      expect(el.shadowRoot?.textContent?.includes('Add a project to see its files') ?? false, why).to.equal(shown);
    }
  });

  it("lists the root's entries at the top level", async () => {
    /** @type {AcpFileTree} */
    const el = await fixture(html`<acp-file-tree .rootId=${'root-1'} .root=${'/p'} .listDir=${listDir}></acp-file-tree>`);
    await until(() => treeOf(el).nodes.getChildIds().length > 0);
    expect(treeOf(el).nodes.getChildIds()).to.deep.equal(['src', 'a.txt']);
  });

  it("hints a row's path once, on its label", async () => {
    // Arrange
    /** @type {AcpFileTree} */
    const el = await fixture(html`<acp-file-tree .rootId=${'root-2'} .root=${'/p'} .listDir=${listDir}></acp-file-tree>`);
    const shadow = /** @type {ShadowRoot} */ (treeOf(el).shadowRoot);
    const hints = () => [...shadow.querySelectorAll('md-tooltip')].map((t) => t.textContent?.trim());
    // Act
    await until(() => hints().includes('a.txt'));
    // Assert
    expect(hints().filter((hint) => hint === 'a.txt')).to.have.length(1);
    expect(tooltipOf(shadow.getElementById('acp-file-tree-label:a.txt'))).to.equal('a.txt');
  });

  it('reveals a nested file, storing the folders it expanded', async () => {
    /** @type {string[][]} */
    const sent = [];
    /** @type {AcpFileTree} */
    const el = await fixture(
      html`<acp-file-tree
        .rootId=${'root-3'}
        .root=${'/wt/fix-login'}
        .listDir=${listDir}
        @acp-expanded-change=${(/** @type {CustomEvent<{ paths: string[] }>} */ e) => {
          sent.push(e.detail.paths);
          el.expanded = e.detail.paths;
        }}
      ></acp-file-tree>`,
    );
    const tree = treeOf(el);
    await until(() => tree.nodes.getChildIds().length > 0);
    el.reveal('src/x.js');
    await until(() => tree.selection.get().has('src/x.js'));
    expect(sent.at(-1)).to.deep.equal(['src']);
  });
});
