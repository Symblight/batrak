import { StoreController } from '../store/StoreController.js';

/** @typedef {import('../../components/acp-resize-handle/acp-resize-handle.js').ResizeEventDetail} ResizeEventDetail */
/** @typedef {import('../../models/types.js').ColumnWidths} ColumnWidths */

/**
 * One resizable column.
 * @typedef {Object} ResizableColumn
 * @property {string} property CSS custom property the host's styles size the column with,
 *   e.g. `--session-column-width`. Its value in `tokens.css` (any length, e.g. a share of `100vw`) is
 *   the default width.
 * @property {number} min px
 * @property {number} max px
 */

/**
 * @typedef {Object} ColumnResizeConfig
 * @property {Record<string, ResizableColumn>} columns Keyed by the `name` of their `acp-resize-handle`.
 * @property {import('nanostores').WritableAtom<ColumnWidths>} store Widths outside a drag, usually the
 *   persisted `$columnWidths`; shared by all hosts, so column names are unique app-wide.
 */

/** @typedef {import('lit').ReactiveControllerHost & HTMLElement} ResizeHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */

const EVENTS = /** @type {const} */ ([
  'acp-resize-start',
  'acp-resize',
  'acp-resize-end',
  'acp-resize-step',
  'acp-resize-reset',
]);

/**
 * @param {string} property Custom property defined on `:root`.
 * @returns {number} Its value as a width in px; NaN when unset.
 */
function rootLengthPx(property) {
  if (!getComputedStyle(document.documentElement).getPropertyValue(property).trim()) return NaN;
  // A probe resolves any length (`calc()`, `vw`, …) that `parseFloat` can't.
  const probe = document.createElement('div');
  probe.style.cssText = `position: absolute; visibility: hidden; width: var(${property})`;
  document.body.append(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px;
}

/**
 * Column widths of one host, driven by the `acp-resize-*` events of the `acp-resize-handle`s in its
 * shadow root. Writes each width to its CSS custom property on the host and re-renders the host,
 * so handles can bind `width()` / `column()` for their ARIA values. A drag stays local until it ends,
 * then lands in the store; every store change (another window included) is applied back.
 * @implements {ReactiveController}
 */
export class ColumnResizeController {
  /** @type {ResizeHost} */
  #host;
  /** @type {ColumnResizeConfig} */
  #config;
  /** @type {ColumnWidths} Applied width per column; defaults are read from CSS on connect. */
  #widths = {};
  /** @type {Record<string, number>} */
  #defaults = {};
  /** @type {{ name: string, startWidth: number } | null} */
  #drag = null;

  /**
   * @param {ResizeHost} host
   * @param {ColumnResizeConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
    // Added after this controller, so it connects after `#readDefaults()` has run.
    new StoreController(host, { store: config.store, onChange: this.#applyStored });
  }

  hostConnected() {
    for (const type of EVENTS) this.#host.addEventListener(type, this.#onEvent);
    window.addEventListener('resize', this.#onWindowResize);
    this.#readDefaults();
  }

  hostDisconnected() {
    for (const type of EVENTS) this.#host.removeEventListener(type, this.#onEvent);
    window.removeEventListener('resize', this.#onWindowResize);
    this.#drag = null;
  }

  /**
   * @param {string} name
   * @returns {number} Current width in px.
   */
  width(name) {
    return this.#widths[name] ?? 0;
  }

  /**
   * Bindings for the column's `acp-resize-handle`.
   * @param {string} name
   * @returns {{ value: number, min: number, max: number }}
   */
  column(name) {
    const { min, max } = this.#config.columns[name];
    return { value: this.width(name), min, max };
  }

  /** Read at `:root`, where the host's inline overrides don't reach. */
  #readDefaults() {
    for (const [name, { property, min }] of Object.entries(this.#config.columns)) {
      const px = rootLengthPx(property);
      this.#defaults[name] = Number.isFinite(px) ? px : min;
    }
  }

  /** Defaults are shares of the window, so columns still at their default follow its size. */
  #onWindowResize = () => {
    this.#readDefaults();
    this.#applyStored(this.#config.store.get());
  };

  /** @param {ColumnWidths} stored Skips a column being dragged; the drag's end stores its width anyway. */
  #applyStored = (stored) => {
    for (const name of Object.keys(this.#config.columns)) {
      if (name !== this.#drag?.name) this.#apply(name, stored[name] ?? this.#defaults[name]);
    }
  };

  /** @param {Event} e */
  #onEvent = (e) => {
    const { name, delta = 0 } = /** @type {CustomEvent<ResizeEventDetail>} */ (e).detail;
    if (!(name in this.#config.columns)) return; // another host's column: let it bubble on
    e.stopPropagation();
    switch (e.type) {
      case 'acp-resize-start':
        this.#drag = { name, startWidth: this.width(name) };
        break;
      case 'acp-resize':
        if (this.#drag?.name === name) this.#apply(name, this.#drag.startWidth + delta);
        break;
      case 'acp-resize-end':
        this.#drag = null;
        this.#commit(name, this.width(name));
        break;
      case 'acp-resize-step':
        this.#apply(name, this.width(name) + delta);
        this.#commit(name, this.width(name));
        break;
      case 'acp-resize-reset':
        this.#commit(name, undefined);
        break;
    }
  };

  /**
   * @param {string} name
   * @param {number} width px, clamped to the column's range.
   */
  #apply(name, width) {
    const { property, min, max } = this.#config.columns[name];
    const clamped = Math.round(Math.min(max, Math.max(min, width)));
    if (this.#widths[name] === clamped) return;
    this.#widths[name] = clamped;
    this.#host.style.setProperty(property, `${clamped}px`);
    this.#host.requestUpdate();
  }

  /**
   * Stores a column's width; `undefined` drops it, back to the CSS default. Applied via `#applyStored`.
   * @param {string} name
   * @param {number | undefined} width
   */
  #commit(name, width) {
    const { [name]: _, ...rest } = this.#config.store.get();
    this.#config.store.set(width === undefined ? rest : { ...rest, [name]: width });
  }
}
