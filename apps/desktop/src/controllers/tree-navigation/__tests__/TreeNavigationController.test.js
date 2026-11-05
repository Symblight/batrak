import { LitElement, html } from 'lit';
import { expect, fixture } from '../../../../test/fixture.js';
import { TreeNavigationController } from '../TreeNavigationController.js';

/** @typedef {import('../TreeNavigationController.js').TreeNode} TreeNode */

class TestRow extends LitElement {
  static properties = { tabStop: { type: Boolean } };
  constructor() {
    super();
    this.tabStop = true;
  }
  createRenderRoot() {
    return this;
  }
  focusRow() {
    this.querySelector('div')?.focus();
  }
  render() {
    return html`<div role="treeitem" tabindex=${this.tabStop ? 0 : -1}>${this.dataset.label}</div>`;
  }
}
customElements.define('x-tree-row', TestRow);

/** @type {[string, string, string | null, boolean | null][]} key, label, parent, expanded (null: a leaf) */
const DATA = [
  ['alpha', 'Alpha', null, true],
  ['a1', 'Apple', 'alpha', null],
  ['a2', 'Apricot', 'alpha', null],
  ['beta', 'Beta', null, false],
  ['b1', 'Banana', 'beta', null],
  ['gamma', 'Gamma', null, true],
];

class TestTree extends LitElement {
  createRenderRoot() {
    return this;
  }
  /** @type {string[]} */
  toggles = [];
  /** @type {Map<string, boolean>} */
  open = new Map(DATA.flatMap(([key, , , expanded]) => (expanded === null ? [] : [[key, expanded]])));
  tree = new TreeNavigationController(this, {
    nodes: () => this.#nodes(),
    toggle: (node, expanded) => {
      this.toggles.push(`${node.key}:${expanded}`);
      this.open.set(node.key, expanded);
      this.requestUpdate();
    },
  });
  #shown() {
    return DATA.filter(([, , parent]) => parent === null || this.open.get(parent));
  }
  #nodes() {
    return this.#shown().map(([key, label, parent]) => ({
      key,
      label,
      parent,
      level: parent === null ? 1 : 2,
      expanded: this.open.get(key) ?? null,
      el: /** @type {import('../TreeNavigationController.js').TreeRow} */ (this.querySelector(`[data-key="${key}"]`)),
    }));
  }
  render() {
    return html`<div role="tree" @keydown=${this.tree.onKeydown} @focusin=${this.tree.onFocusin}>
      ${this.#shown().map(([key, label]) => html`<x-tree-row data-key=${key} data-label=${label}></x-tree-row>`)}
    </div>`;
  }
}
customElements.define('x-tree', TestTree);

/** @param {TestTree} el @param {string} key */
const row = (el, key) => /** @type {TestRow} */ (el.querySelector(`[data-key="${key}"]`));
/** @param {TestTree} el */
const stops = (el) => [...el.querySelectorAll('x-tree-row')].filter((r) => /** @type {TestRow} */ (r).tabStop).map((r) => /** @type {HTMLElement} */ (r).dataset.key);
const focused = () => /** @type {HTMLElement} */ (document.activeElement?.closest('x-tree-row'))?.dataset.key;
/** @param {Element | null} target @param {string} key @param {KeyboardEventInit} [init] */
const press = (target, key, init = {}) => target?.querySelector('div')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, ...init }));

/** Renders the tree with focus on `key`. @param {string} key */
async function focusOn(key) {
  const el = /** @type {TestTree} */ (await fixture(html`<x-tree></x-tree>`));
  await el.updateComplete;
  for (const r of el.querySelectorAll('x-tree-row')) await /** @type {TestRow} */ (r).updateComplete;
  row(el, key).focusRow();
  await el.updateComplete;
  return el;
}

describe('TreeNavigationController', () => {
  it('leaves one tab stop: the first node, then wherever focus went', async () => {
    // Arrange
    const el = /** @type {TestTree} */ (await fixture(html`<x-tree></x-tree>`));
    await el.updateComplete;
    // Assert
    expect(stops(el)).to.deep.equal(['alpha']);
    // Act
    row(el, 'gamma').focusRow();
    // Assert
    expect(stops(el)).to.deep.equal(['gamma']);
  });

  it('moves with Up, Down, Home and End, and stops at the ends', async () => {
    const el = await focusOn('alpha');
    const steps = [
      ['ArrowDown', 'a1'],
      ['ArrowDown', 'a2'],
      ['ArrowUp', 'a1'],
      ['End', 'gamma'],
      ['ArrowDown', 'gamma'],
      ['Home', 'alpha'],
      ['ArrowUp', 'alpha'],
    ];
    for (const [key, expected] of steps) {
      // Act
      press(row(el, focused() ?? ''), key);
      // Assert
      expect(focused(), key).to.equal(expected);
    }
  });

  it('expands with Right and enters the node, collapses with Left and leaves to the parent', async () => {
    const el = await focusOn('beta');
    // Act: collapsed → expand
    press(row(el, 'beta'), 'ArrowRight');
    await el.updateComplete;
    // Assert
    expect(el.toggles).to.deep.equal(['beta:true']);
    expect(focused()).to.equal('beta');
    // Act: expanded → first child
    press(row(el, 'beta'), 'ArrowRight');
    // Assert
    expect(focused()).to.equal('b1');
    // Act: a child → its parent; the parent collapses
    press(row(el, 'b1'), 'ArrowLeft');
    expect(focused()).to.equal('beta');
    press(row(el, 'beta'), 'ArrowLeft');
    expect(el.toggles).to.deep.equal(['beta:true', 'beta:false']);
    // A leaf and a root do nothing more
    press(row(el, 'gamma'), 'ArrowRight');
    expect(focused()).to.equal('beta');
  });

  it('jumps to the next node starting with the typed letters, which add up', async () => {
    const el = await focusOn('alpha');
    // Act + Assert: one letter goes to the next match
    press(row(el, 'alpha'), 'b');
    expect(focused()).to.equal('beta');
    // Typed quickly, "be" is still Beta
    press(row(el, 'beta'), 'e');
    expect(focused()).to.equal('beta');

    const other = await focusOn('gamma');
    press(row(other, 'gamma'), 'a');
    expect(focused()).to.equal('alpha');
    // "ap" is Apple, not Alpha again
    press(row(other, 'alpha'), 'p');
    expect(focused()).to.equal('a1');
  });

  it('ignores keys from inside a row and shortcuts', async () => {
    const el = await focusOn('alpha');
    // Act
    press(row(el, 'alpha'), 'ArrowDown', { ctrlKey: true });
    press(row(el, 'alpha'), 'b', { metaKey: true });
    const inner = document.createElement('input');
    row(el, 'alpha').append(inner);
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
    // Assert
    expect(focused()).to.equal('alpha');
  });
});
