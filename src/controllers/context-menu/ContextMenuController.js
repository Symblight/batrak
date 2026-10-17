/** @typedef {import('lit').ReactiveControllerHost & HTMLElement} ContextMenuHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */

/**
 * @template T
 * @typedef {Object} ContextMenuConfig
 * @property {() => HTMLElementTagNameMap['md-menu'] | null} menu The host's one `md-menu`, shared by
 *   every target.
 * @property {(value: string, target: T) => void} onSelect An item was chosen for `target`.
 */

/**
 * The context menu showing, app-wide: a right-click doesn't light-dismiss menus, so opening one
 * (another host's, or another menu of the same host) closes the one that's open.
 * @type {HTMLElementTagNameMap['md-menu'] | null}
 */
let shown = null;

/**
 * A context menu shared by many targets (one `md-menu` per host): opens it at the pointer or under a
 * focused target, remembers which target it is open for (`target`, re-rendering the host) and hands
 * the chosen item's `value` to `onSelect`. Only one context menu shows at a time, app-wide.
 * The host binds `onContextMenu` / `onKeydown` on each target
 * and `onSelect` / `onClosed` on the menu.
 * @template T
 * @implements {ReactiveController}
 */
export class ContextMenuController {
  /** @type {ContextMenuHost} */
  #host;
  /** @type {ContextMenuConfig<T>} */
  #config;
  /** @type {T | null} */
  #target = null;

  /**
   * @param {ContextMenuHost} host
   * @param {ContextMenuConfig<T>} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  /** @returns {T | null} The target the menu is open for. */
  get target() {
    return this.#target;
  }

  hostDisconnected() {
    this.#target = null;
  }

  /**
   * Opens the menu for `target` at viewport coordinates; moves it there if it's open already.
   * @param {T} target
   * @param {number} x
   * @param {number} y
   */
  async open(target, x, y) {
    const menu = this.#config.menu();
    if (!menu) return;
    this.#setTarget(target);
    // The items can depend on the target: render them before the menu is measured and placed.
    await this.#host.updateComplete;
    // A right-click doesn't light-dismiss the menu, and `openAtPoint()` on an open menu doesn't move
    // it: hide it first so it shows again at the new point.
    if (shown && shown !== menu && shown.open) shown.open = false;
    shown = menu;
    if (menu.open) {
      menu.open = false;
      await menu.updateComplete;
    }
    menu.openAtPoint(x, y);
  }

  /**
   * @param {T} target
   * @param {MouseEvent} e
   */
  onContextMenu(target, e) {
    e.preventDefault();
    e.stopPropagation();
    this.open(target, e.clientX, e.clientY);
  }

  /**
   * ContextMenu or Shift+F10 opens the menu under the focused target; returns whether it did, so the
   * host can go on with its own keys.
   * @param {T} target
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  onKeydown(target, e) {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return false;
    e.preventDefault();
    const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
    this.open(target, rect.left + 24, rect.bottom);
    return true;
  }

  onSelect = (/** @type {Event} */ e) => {
    // The item's `select` bubbles here too; `md-menu` re-dispatches it, so take only the menu's own.
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (this.#target !== null) this.#config.onSelect(value, this.#target);
  };

  onClosed = () => {
    // `closed` comes after the close animation: the menu may have reopened for another target since.
    if (this.#config.menu()?.open) return;
    this.#setTarget(null);
  };

  /** @param {T | null} target */
  #setTarget(target) {
    if (this.#target === target) return;
    this.#target = target;
    this.#host.requestUpdate();
  }
}
