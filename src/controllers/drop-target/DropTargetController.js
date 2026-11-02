/** @typedef {import('lit').ReactiveControllerHost & HTMLElement} DropTargetHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */

/**
 * @typedef {Object} DropTargetConfig
 * @property {() => string | null} name What a sortable's `dropTo` names; `null`: not a target now.
 * @property {() => Element | null} area Where a drag counts as over the target.
 * @property {(id: string) => boolean} accepts Whether it takes the dragged item.
 * @property {(id: string, point: { x: number, y: number }, step: number) => void} over The dragged item is over `area`, `step` px
 *   wide with its gap (the room it needs); called on every move.
 * @property {() => void} leave The dragged item left, was cancelled, or was dropped.
 * @property {(id: string, point: { x: number, y: number }) => void} drop The dragged item was released over `area`.
 */

/** @type {Set<DropTargetController>} */
const targets = new Set();

/**
 * A host that takes items dragged out of another host's `SortableController`, which finds it by the
 * name its `dropTo` gives: the pointer is over `area` and `accepts` the item. Pointer events only, as
 * the sortable is (no HTML5 drag and drop).
 * @implements {ReactiveController}
 */
export class DropTargetController {
  /** @type {DropTargetConfig} */
  #config;

  /**
   * @param {DropTargetHost} host
   * @param {DropTargetConfig} config
   */
  constructor(host, config) {
    this.#config = config;
    host.addController(this);
  }

  hostConnected() {
    targets.add(this);
  }

  hostDisconnected() {
    targets.delete(this);
    this.#config.leave();
  }

  /**
   * @param {string} name
   * @param {string} id The dragged item.
   * @param {{ x: number, y: number }} point
   * @returns {DropTargetController | null} The target of that name the pointer is over, if it takes the item.
   */
  static at(name, id, point) {
    for (const target of targets) {
      const rect = target.#config.area()?.getBoundingClientRect();
      if (target.#config.name() !== name || !rect?.width || !rect.height || !target.#config.accepts(id)) continue;
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) return target;
    }
    return null;
  }

  /**
   * @param {string} id
   * @param {{ x: number, y: number }} point
   * @param {number} step
   */
  over(id, point, step) {
    this.#config.over(id, point, step);
  }

  leave() {
    this.#config.leave();
  }

  /**
   * @param {string} id
   * @param {{ x: number, y: number }} point
   */
  drop(id, point) {
    this.#config.drop(id, point);
  }
}
