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
