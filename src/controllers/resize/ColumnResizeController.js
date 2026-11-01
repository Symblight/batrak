import { StoreController } from '../store/StoreController.js';

/** @typedef {import('../../components/resize-handle/resize-handle.js').ResizeEventDetail} ResizeEventDetail */
/** @typedef {import('../../components/resize-handle/resize-handle.js').ResizeMeasure} ResizeMeasure */
/** @typedef {import('../../hooks/settings/types.js').ColumnWidths} ColumnWidths */

/**
 * One resizable column.
 * @typedef {Object} ResizableColumn
 * @property {string} property CSS custom property on `:root` whose value (any length, e.g. a share of
 *   `100vw`, in `tokens.css`) is the default width, e.g. `--acp-session-column-width`.
 * @property {number} min px
 * @property {number} max px
 * @property {string} [partner] The column across the handle, when it's resizable too: it gets the
 *   opposite width change, so it keeps the size the drag leaves it. Without one the neighbor is a
 *   flex column that takes up the slack by itself.
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
 * shadow root. Re-renders the host on every change, so columns bind `columnStyle()` and handles
 * `column()` for their ARIA values. A drag stays local until it ends, then lands in the store; every
 * store change (another window included) is applied back.
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
  /** @type {{ name: string, measure: ResizeMeasure | undefined, startWidth: number } | null} */
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
   * The column's inline size. Not a custom property on the host: changing an inherited one restyles
   * everything below it on every frame of a drag.
   * @param {string} name
   */
  columnStyle(name) {
    const px = `${this.width(name)}px`;
    return `flex-basis: ${px}; width: ${px}`;
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

  /** @param {ColumnWidths} stored Skips the columns being dragged; the drag's end stores them anyway. */
  #applyStored = (stored) => {
    const drag = this.#drag;
    const dragged = drag ? [drag.name, this.#config.columns[drag.name].partner] : [];
    for (const name of Object.keys(this.#config.columns)) {
      if (!dragged.includes(name)) this.#apply(name, stored[name] ?? this.#defaults[name]);
    }
  };

  /** @param {Event} e */
  #onEvent = (e) => {
    const { name, delta = 0, measure } = /** @type {CustomEvent<ResizeEventDetail>} */ (e).detail;
    if (!(name in this.#config.columns)) return; // another host's column: let it bubble on
    e.stopPropagation();
    switch (e.type) {
      case 'acp-resize-start':
        this.#drag = { name, measure, startWidth: measure?.width ?? this.width(name) };
        break;
      case 'acp-resize':
        if (this.#drag?.name === name) this.#resize(name, this.#drag.startWidth, this.#drag.measure, delta);
        break;
      case 'acp-resize-end':
        this.#drag = null;
        this.#commitPair(name);
        break;
      case 'acp-resize-step':
        this.#resize(name, measure?.width ?? this.width(name), measure, delta);
        this.#commitPair(name);
        break;
      case 'acp-resize-reset':
        this.#commit({ [name]: undefined });
        break;
    }
  };

  /**
   * Moves width between the column and its neighbor across the handle only: the change stops where
   * either side reaches its limit, so no other column has to give or take any.
   * @param {string} name
   * @param {number} startWidth px
   * @param {ResizeMeasure | undefined} measure Without it (no neighbor), only the column's range applies.
   * @param {number} delta px, positive widens the column.
   */
  #resize(name, startWidth, measure, delta) {
    const { min, max, partner } = this.#config.columns[name];
    let lo = min - startWidth;
    let hi = max - startWidth;
    if (measure) {
      const partnerColumn = partner ? this.#config.columns[partner] : undefined;
      hi = Math.min(hi, measure.neighborWidth - Math.max(measure.neighborMin, partnerColumn?.min ?? 0));
      if (partnerColumn) lo = Math.max(lo, measure.neighborWidth - partnerColumn.max);
    }
    const d = Math.max(Math.min(lo, 0), Math.min(Math.max(hi, 0), delta));
    this.#apply(name, startWidth + d);
    if (partner && measure) this.#apply(partner, measure.neighborWidth - d);
  }

  /** @param {string} name Stores the column and its partner. */
  #commitPair(name) {
    const { partner } = this.#config.columns[name];
    this.#commit(partner ? { [name]: this.width(name), [partner]: this.width(partner) } : { [name]: this.width(name) });
  }

  /**
   * @param {string} name
   * @param {number} width px, clamped to the column's range.
   */
  #apply(name, width) {
    const { min, max } = this.#config.columns[name];
    const clamped = Math.round(Math.min(max, Math.max(min, width)));
    if (this.#widths[name] === clamped) return;
    this.#widths[name] = clamped;
    this.#host.requestUpdate();
  }

  /**
   * Stores column widths; `undefined` drops one, back to its CSS default. Applied via `#applyStored`.
   * @param {Record<string, number | undefined>} widths
   */
  #commit(widths) {
    /** @type {ColumnWidths} */
    const next = { ...this.#config.store.get() };
    for (const [name, width] of Object.entries(widths)) {
      if (width === undefined) delete next[name];
      else next[name] = width;
    }
    this.#config.store.set(next);
  }
}
