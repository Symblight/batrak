/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */

/**
 * A row element of the tree: it renders its `role="treeitem"` with `tabindex` 0 while `tabStop` is set,
 * -1 otherwise, and focuses that item in `focusRow()`.
 * @typedef {HTMLElement & { tabStop: boolean, focusRow: () => unknown }} TreeRow
 */

/**
 * A shown node of the tree, in display order.
 * @typedef {Object} TreeNode
 * @property {string} key Unique in the tree.
 * @property {TreeRow} el
 * @property {string} label What type-ahead matches.
 * @property {string | null} parent The key of its parent node.
 * @property {boolean | null} expanded `null` for a node that cannot open (a leaf).
 */

/**
 * @typedef {Object} TreeNavigationConfig
 * @property {() => TreeNode[]} nodes The nodes shown now, in order. Rows not rendered yet have no `el`
 *   and are left out.
 * @property {(node: TreeNode, expanded: boolean) => void} [toggle] Opens or closes a node. Without it
 *   Left and Right are left to the rows.
 */

/** ms after which typed letters start a new search. */
const TYPE_AHEAD_MS = 700;

/**
 * Keyboard behavior of a WAI-ARIA tree whose rows are elements of their own: Up, Down, Home and End,
 * Right and Left to open, close, enter and leave a node, type-ahead, and a single Tab stop (roving
 * `tabStop` on the rows). The host binds `onKeydown` and `onFocusin` on the element with
 * `role="tree"`. A key pressed inside a row (a text field, a button) is left alone.
 * @implements {ReactiveController}
 */
export class TreeNavigationController {
  /** @type {ReactiveControllerHost} */
  #host;

  /** @type {TreeNavigationConfig} */
  #config;

  /** @type {string | null} Key of the node that last had focus. */
  #active = null;

  #typed = '';

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #typedTimer;

  /**
   * @param {ReactiveControllerHost} host
   * @param {TreeNavigationConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  hostUpdated() {
    this.#applyTabStop();
  }

  hostDisconnected() {
    clearTimeout(this.#typedTimer);
  }

  /** Gives the Tab stop to the focused node, else to the first. */
  #applyTabStop() {
    const nodes = this.#config.nodes().filter((n) => n.el);
    const stop = nodes.find((n) => n.key === this.#active) ?? nodes[0];
    for (const node of nodes) node.el.tabStop = node === stop;
  }

  /**
   * @param {TreeNode[]} nodes
   * @param {EventTarget | null} target The row, or something in it when the rows are light DOM.
   */
  #nodeOf(nodes, target) {
    return nodes.find((n) => n.el === target || (target instanceof Node && n.el.contains(target)));
  }

  /** @param {FocusEvent} e */
  onFocusin = (e) => {
    const node = this.#nodeOf(this.#config.nodes(), e.target);
    if (!node) return;
    this.#active = node.key;
    this.#applyTabStop();
  };

  /** @param {KeyboardEvent} e */
  onKeydown = (e) => {
    const item = e.composedPath()[0];
    if (!(item instanceof Element) || item.getAttribute('role') !== 'treeitem' || e.isComposing) return;
    const nodes = this.#config.nodes().filter((n) => n.el);
    const node = this.#nodeOf(nodes, e.target);
    if (!node) return;
    const at = nodes.indexOf(node);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    /** @type {TreeNode | undefined} */
    let next;
    switch (e.key) {
      case 'ArrowDown':
        next = nodes[Math.min(at + 1, nodes.length - 1)];
        break;
      case 'ArrowUp':
        next = nodes[Math.max(at - 1, 0)];
        break;
      case 'Home':
        next = nodes[0];
        break;
      case 'End':
        next = nodes[nodes.length - 1];
        break;
      case 'ArrowRight':
        if (!this.#config.toggle) return;
        if (node.expanded === false) this.#config.toggle(node, true);
        else if (node.expanded && nodes[at + 1]?.parent === node.key) next = nodes[at + 1];
        break;
      case 'ArrowLeft':
        if (!this.#config.toggle) return;
        if (node.expanded) this.#config.toggle(node, false);
        else next = nodes.find((n) => n.key === node.parent);
        break;
      default:
        if (e.key.length !== 1 || e.shiftKey && e.key === ' ') return;
        next = this.#typeAhead(nodes, at, e.key);
        if (next === undefined) return;
    }
    e.preventDefault();
    if (next && next !== node) next.el.focusRow();
  };

  /**
   * @param {TreeNode[]} nodes
   * @param {number} at
   * @param {string} char
   * @returns {TreeNode | undefined} The node to go to; the current one when nothing else matches.
   */
  #typeAhead(nodes, at, char) {
    if (char === ' ' && this.#typed === '') return undefined;
    clearTimeout(this.#typedTimer);
    this.#typedTimer = setTimeout(() => (this.#typed = ''), TYPE_AHEAD_MS);
    this.#typed += char.toLowerCase();
    // One letter goes to the next match; a longer word may still be on the current node.
    const from = this.#typed.length === 1 ? at + 1 : at;
    const ordered = [...nodes.slice(from), ...nodes.slice(0, from)];
    return ordered.find((n) => n.label.toLowerCase().startsWith(this.#typed)) ?? nodes[at];
  }
}
