import { LitElement, html } from 'lit';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { disableNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/utils/disable-native-drag-preview';
import { preventUnhandled } from '@atlaskit/pragmatic-drag-and-drop/utils/prevent-unhandled';
import styles from './acp-resize-handle.css?inline';

/**
 * Which edge of the resized column the handle sits on: `end` grows the column when dragged
 * right (column before the handle), `start` when dragged left (column after it).
 * @typedef {'start' | 'end'} ResizeEdge
 */

/**
 * Detail of every `acp-resize-*` event. `delta` is in px, oriented so that a positive value
 * widens the column: since drag start for `acp-resize`, from the current width for
 * `acp-resize-step`; absent for `-start`, `-end` and `-reset`.
 * @typedef {{ name: string, delta?: number }} ResizeEventDetail
 */

/** Keyboard step in px; Shift multiplies it. */
const STEP = 10;
const LARGE_STEP = 50;

/**
 * @tag acp-resize-handle
 * @summary Column divider: drag (Pragmatic drag and drop), arrow keys, or double-click to reset.
 * @fires acp-resize-start `{ name }`
 * @fires acp-resize `{ name, delta }` while dragging, delta since start
 * @fires acp-resize-end `{ name }`
 * @fires acp-resize-step `{ name, delta }` from the keyboard, delta from the current width
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

  /** @type {(() => void) | null} Unregisters the draggable. */
  #cleanup = null;

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
    this.#cleanup = draggable({
      element: this,
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        disableNativeDragPreview({ nativeSetDragImage });
        // Without it the drop is "unhandled" and the browser animates a ghost back for ~a second.
        preventUnhandled.start();
      },
      onDragStart: () => {
        this.dragging = true;
        this.#emit('acp-resize-start');
      },
      onDrag: ({ location }) => {
        this.#emit('acp-resize', this.#orient(location.current.input.clientX - location.initial.input.clientX));
      },
      onDrop: ({ location }) => {
        // `onDrag` is throttled to animation frames; a release right after a move would lose it.
        this.#emit('acp-resize', this.#orient(location.current.input.clientX - location.initial.input.clientX));
        preventUnhandled.stop();
        this.dragging = false;
        this.#emit('acp-resize-end');
      },
    });
  }

  disconnectedCallback() {
    this.#cleanup?.();
    this.#cleanup = null;
    this.removeEventListener('keydown', this.#onKeydown);
    this.removeEventListener('dblclick', this.#onDblclick);
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
   */
  #emit(type, delta) {
    /** @type {ResizeEventDetail} */
    const detail = delta === undefined ? { name: this.name } : { name: this.name, delta };
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? LARGE_STEP : STEP;
    this.#emit('acp-resize-step', this.#orient(e.key === 'ArrowRight' ? step : -step));
  };

  #onDblclick = () => {
    this.#emit('acp-resize-reset');
  };

  render() {
    return html`<div class="acp-resize-handle__line" part="line"></div>`;
  }
}

customElements.define('acp-resize-handle', AcpResizeHandle);
