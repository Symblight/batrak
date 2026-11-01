import { LitElement, html } from 'lit';
import styles from './resize-handle.css?inline';

/**
 * Which edge of the resized column the handle sits on: `end` grows the column when dragged
 * right (column before the handle), `start` when dragged left (column after it). On the vertical
 * axis: dragged down (row before it) and up (row after it).
 * @typedef {'start' | 'end'} ResizeEdge
 */

/**
 * Rendered sizes on both sides of the handle along its axis (widths, heights on the vertical axis),
 * measured when a drag starts or a key steps: flex can make a column narrower than its set width.
 * @typedef {Object} ResizeMeasure
 * @property {number} width The resized column.
 * @property {number} neighborWidth The column on the handle's other side, which gives up the width.
 * @property {number} neighborMin Its CSS `min-width` (`min-height`), px.
 */

/**
 * Detail of every `acp-resize-*` event. `delta` is in px, oriented so that a positive value
 * widens the column (heightens the row): since drag start for `acp-resize`, from the current width for
 * `acp-resize-step`; absent for `-start`, `-end` and `-reset`. `measure` comes with `-start` and
 * `-step`.
 * @typedef {{ name: string, delta?: number, measure?: ResizeMeasure }} ResizeEventDetail
 */

/** Keyboard step in px; Shift multiplies it. */
const STEP = 10;
const LARGE_STEP = 50;
/** Pointer travel in px before a press becomes a drag, so a click or double-click stores nothing. */
const DRAG_THRESHOLD = 3;

/**
 * @param {Element} from
 * @param {'previousElementSibling' | 'nextElementSibling'} direction
 * @returns {Element | null} The nearest sibling that takes up space; hidden columns are skipped.
 */
function rendered(from, direction) {
  let el = from[direction];
  while (el && getComputedStyle(el).display === 'none') el = el[direction];
  return el;
}

/**
 * @tag acp-resize-handle
 * @summary Column divider (`axis="y"`: a row divider, dragged up and down): drag (pointer capture), arrow keys, or double-click to reset.
 * @fires acp-resize-start `{ name, measure }`
 * @fires acp-resize `{ name, delta }` while dragging, delta since start
 * @fires acp-resize-end `{ name }`
 * @fires acp-resize-step `{ name, delta, measure }` from the keyboard, delta from the current width
 * @fires acp-resize-reset `{ name }` on double-click
 */
export class AcpResizeHandle extends LitElement {
  static properties = {
    /** Id of the column it resizes, as configured in the host's `ColumnResizeController`. */
    name: { type: String },
    edge: { type: String, reflect: true },
    /** `x`: a vertical line between columns, dragged sideways; `y`: a horizontal line between rows, dragged up and down. */
    axis: { type: String, reflect: true },
    /** Accessible name, e.g. "Resize sessions column". */
    label: { type: String },
    /** Current, minimum and maximum width in px, for `aria-value*`. */
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    dragging: { type: Boolean, reflect: true },
  };

  static styles = styles;

  /** @type {{ pointerId: number, start: number } | null} The pressed pointer, until it's released. */
  #press = null;

  constructor() {
    super();
    /** @type {string} */
    this.name = '';
    /** @type {ResizeEdge} */
    this.edge = 'end';
    /** @type {'x' | 'y'} */
    this.axis = 'x';
    /** @type {string} */
    this.label = '';
    /** @type {number} */
    this.value = 0;
    /** @type {number} */
    this.min = 0;
    /** @type {number} */
    this.max = 0;
    /** @type {boolean} */
    this.dragging = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'separator');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    this.addEventListener('keydown', this.#onKeydown);
    this.addEventListener('dblclick', this.#onDblclick);
    this.addEventListener('pointerdown', this.#onPointerdown);
    this.addEventListener('pointermove', this.#onPointermove);
    this.addEventListener('pointerup', this.#onPointerup);
    this.addEventListener('lostpointercapture', this.#onLostPointerCapture);
  }

  disconnectedCallback() {
    this.removeEventListener('keydown', this.#onKeydown);
    this.removeEventListener('dblclick', this.#onDblclick);
    this.removeEventListener('pointerdown', this.#onPointerdown);
    this.removeEventListener('pointermove', this.#onPointermove);
    this.removeEventListener('pointerup', this.#onPointerup);
    this.removeEventListener('lostpointercapture', this.#onLostPointerCapture);
    this.#press = null;
    /** @type {boolean} */
    this.dragging = false;
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues} changed */
  updated(changed) {
    if (changed.has('axis')) this.setAttribute('aria-orientation', this.axis === 'y' ? 'horizontal' : 'vertical');
    if (changed.has('label')) this.setAttribute('aria-label', this.label);
    if (changed.has('value')) this.setAttribute('aria-valuenow', String(Math.round(this.value)));
    if (changed.has('min')) this.setAttribute('aria-valuemin', String(this.min));
    if (changed.has('max')) this.setAttribute('aria-valuemax', String(this.max));
  }

  /**
   * Turns a pointer/key movement along the axis into a size change.
   * @param {number} d px, positive to the right (down on the vertical axis).
   */
  #orient(d) {
    return this.edge === 'start' ? -d : d;
  }

  /** @param {PointerEvent} e The pointer along the axis. */
  #along(e) {
    return this.axis === 'y' ? e.clientY : e.clientX;
  }

  /**
   * @param {string} type
   * @param {number} [delta]
   * @param {ResizeMeasure} [measure]
   */
  #emit(type, delta, measure) {
    /** @type {ResizeEventDetail} */
    const detail = { name: this.name };
    if (delta !== undefined) detail.delta = delta;
    if (measure) detail.measure = measure;
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {PointerEvent} e */
  #onPointerdown = (e) => {
    if (e.button !== 0 || this.#press) return;
    // Keeps text from being selected, and the pointer's events coming here, until release.
    e.preventDefault();
    this.setPointerCapture(e.pointerId);
    this.#press = { pointerId: e.pointerId, start: this.#along(e) };
  };

  /** @param {PointerEvent} e */
  #onPointermove = (e) => {
    if (e.pointerId !== this.#press?.pointerId) return;
    const dx = this.#along(e) - this.#press.start;
    if (!this.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      /** @type {boolean} */
      this.dragging = true;
      this.#emit('acp-resize-start', undefined, this.#measure());
    }
    this.#emit('acp-resize', this.#orient(dx));
  };

  /** @param {PointerEvent} e */
  #onPointerup = (e) => {
    if (e.pointerId !== this.#press?.pointerId) return;
    if (this.dragging) this.#emit('acp-resize', this.#orient(this.#along(e) - this.#press.start));
    this.releasePointerCapture(e.pointerId);
  };

  /** Ends the press however capture ends: release, `pointercancel`, or the element leaving the DOM. */
  #onLostPointerCapture = (/** @type {PointerEvent} */ e) => {
    if (e.pointerId !== this.#press?.pointerId) return;
    this.#press = null;
    if (!this.dragging) return;
    /** @type {boolean} */
    this.dragging = false;
    this.#emit('acp-resize-end');
  };

  /**
   * The resized column is the sibling on the handle's `edge` side, the neighbor the other one.
   * @returns {ResizeMeasure | undefined}
   */
  #measure() {
    const before = rendered(this, 'previousElementSibling');
    const after = rendered(this, 'nextElementSibling');
    const [column, neighbor] = this.edge === 'start' ? [after, before] : [before, after];
    if (!column || !neighbor) return undefined;
    const vertical = this.axis === 'y';
    return {
      width: vertical ? column.getBoundingClientRect().height : column.getBoundingClientRect().width,
      neighborWidth: vertical ? neighbor.getBoundingClientRect().height : neighbor.getBoundingClientRect().width,
      neighborMin: parseFloat(vertical ? getComputedStyle(neighbor).minHeight : getComputedStyle(neighbor).minWidth) || 0,
    };
  }

  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    const [less, more] = this.axis === 'y' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (e.key !== less && e.key !== more) return;
    e.preventDefault();
    const step = e.shiftKey ? LARGE_STEP : STEP;
    this.#emit('acp-resize-step', this.#orient(e.key === more ? step : -step), this.#measure());
  };

  #onDblclick = () => {
    this.#emit('acp-resize-reset');
  };

  render() {
    return html`<div class="acp-resize-handle__line" part="line"></div>`;
  }
}

customElements.define('acp-resize-handle', AcpResizeHandle);
