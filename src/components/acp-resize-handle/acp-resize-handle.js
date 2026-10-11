import { LitElement, html } from 'lit';
import styles from './acp-resize-handle.css?inline';

/**
 * Which edge of the resized column the handle sits on: `end` grows the column when dragged
 * right (column before the handle), `start` when dragged left (column after it).
 * @typedef {'start' | 'end'} ResizeEdge
 */

/**
 * Rendered widths on both sides of the handle, measured when a drag starts or a key steps:
 * flex can make a column narrower than its set width.
 * @typedef {Object} ResizeMeasure
 * @property {number} width The resized column.
 * @property {number} neighborWidth The column on the handle's other side, which gives up the width.
 * @property {number} neighborMin Its CSS `min-width`, px.
 */

/**
 * Detail of every `acp-resize-*` event. `delta` is in px, oriented so that a positive value
 * widens the column: since drag start for `acp-resize`, from the current width for
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
 * @summary Column divider: drag (pointer capture), arrow keys, or double-click to reset.
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
    /** Accessible name, e.g. "Resize sessions column". */
    label: { type: String },
    /** Current, minimum and maximum width in px, for `aria-value*`. */
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    dragging: { type: Boolean, reflect: true },
  };

  static styles = styles;

  /** @type {{ pointerId: number, startX: number } | null} The pressed pointer, until it's released. */
  #press = null;

  constructor() {
    super();
    this.name = '';
    /** @type {ResizeEdge} */
    this.edge = 'end';
    this.label = '';
    this.value = 0;
    this.min = 0;
    this.max = 0;
    this.dragging = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'separator');
    this.setAttribute('aria-orientation', 'vertical');
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
    this.dragging = false;
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues} changed */
  updated(changed) {
    if (changed.has('label')) this.setAttribute('aria-label', this.label);
    if (changed.has('value')) this.setAttribute('aria-valuenow', String(Math.round(this.value)));
    if (changed.has('min')) this.setAttribute('aria-valuemin', String(this.min));
    if (changed.has('max')) this.setAttribute('aria-valuemax', String(this.max));
  }

  /**
   * Turns a horizontal pointer/key movement into a column-width change.
   * @param {number} dx px, positive to the right.
   */
  #orient(dx) {
    return this.edge === 'start' ? -dx : dx;
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
    this.#press = { pointerId: e.pointerId, startX: e.clientX };
  };

  /** @param {PointerEvent} e */
  #onPointermove = (e) => {
    if (e.pointerId !== this.#press?.pointerId) return;
    const dx = e.clientX - this.#press.startX;
    if (!this.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      this.dragging = true;
      this.#emit('acp-resize-start', undefined, this.#measure());
    }
    this.#emit('acp-resize', this.#orient(dx));
  };

  /** @param {PointerEvent} e */
  #onPointerup = (e) => {
    if (e.pointerId !== this.#press?.pointerId) return;
    if (this.dragging) this.#emit('acp-resize', this.#orient(e.clientX - this.#press.startX));
    this.releasePointerCapture(e.pointerId);
  };

  /** Ends the press however capture ends: release, `pointercancel`, or the element leaving the DOM. */
  #onLostPointerCapture = (/** @type {PointerEvent} */ e) => {
    if (e.pointerId !== this.#press?.pointerId) return;
    this.#press = null;
    if (!this.dragging) return;
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
    return {
      width: column.getBoundingClientRect().width,
      neighborWidth: neighbor.getBoundingClientRect().width,
      neighborMin: parseFloat(getComputedStyle(neighbor).minWidth) || 0,
    };
  }

  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? LARGE_STEP : STEP;
    this.#emit('acp-resize-step', this.#orient(e.key === 'ArrowRight' ? step : -step), this.#measure());
  };

  #onDblclick = () => {
    this.#emit('acp-resize-reset');
  };

  render() {
    return html`<div class="acp-resize-handle__line" part="line"></div>`;
  }
}

customElements.define('acp-resize-handle', AcpResizeHandle);
