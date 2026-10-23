import { hiddenTabs } from '../../models/tab-overflow.js';

/** @typedef {import('lit').ReactiveControllerHost & import('lit').LitElement} ReactiveElementHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('../../models/tab-overflow.js').TabSpan} TabSpan */

/**
 * @typedef {Object} TabOverflowConfig
 * @property {() => HTMLElement | null} strip The scroller holding the tabs.
 * @property {() => Element[]} observed Elements whose size changes call for a new measure (the strip, its tabs' row).
 * @property {() => TabSpan[]} spans The tabs' extents in the viewport, in strip order.
 * @property {string} fade The strip's custom property holding each edge's fade width.
 * @property {() => boolean} paused No measuring now (a tab is being dragged).
 */

/**
 * Tells whether the host's tabs overflow their strip (`overflowing`) and which are out of view
 * (`hidden`), re-rendering the host when that changed. The strip is measured against the host: while
 * an overflow button shows, the strip is narrower by its slot, and the button goes only once the tabs
 * fit without it. The host binds `schedule` to the strip's `scroll` and calls it once the tabs change.
 * @implements {ReactiveController}
 */
export class TabOverflowController {
  /** @type {ReactiveElementHost} */
  #host;
  /** @type {TabOverflowConfig} */
  #config;
  #overflowing = false;
  /** @type {readonly string[]} */
  #hidden = [];
  /** @type {number | undefined} */
  #frame;
  #observing = false;
  #observer = new ResizeObserver(() => this.#measure());

  /**
   * @param {ReactiveElementHost} host
   * @param {TabOverflowConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  /** The tabs don't fit the strip. */
  get overflowing() {
    return this.#overflowing;
  }

  /** @returns {readonly string[]} Tabs not fully visible in the strip, in strip order. */
  get hidden() {
    return this.#hidden;
  }

  hostConnected() {
    if (this.#host.hasUpdated) this.#observe();
  }

  hostUpdated() {
    if (!this.#observing) this.#observe();
  }

  #observe() {
    this.#observing = true;
    for (const el of this.#config.observed()) this.#observer.observe(el);
  }

  hostDisconnected() {
    this.#observer.disconnect();
    this.#observing = false;
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }

  /** Measures next frame, once laid out; at most once a frame. */
  schedule = () => {
    if (this.#frame !== undefined) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#measure();
    });
  };

  #measure() {
    const strip = this.#config.strip();
    if (!strip || this.#config.paused()) return;
    const overflowing = strip.scrollWidth > this.#host.clientWidth;
    let hidden = /** @type {readonly string[]} */ ([]);
    if (overflowing) {
      const start = strip.getBoundingClientRect().left + strip.clientLeft;
      const fade = parseFloat(getComputedStyle(strip).getPropertyValue(this.#config.fade)) || 0;
      hidden = hiddenTabs(this.#config.spans(), { start, end: start + strip.clientWidth }, fade);
    }
    if (overflowing === this.#overflowing && hidden.join('\n') === this.#hidden.join('\n')) return;
    this.#overflowing = overflowing;
    this.#hidden = hidden;
    this.#host.requestUpdate();
  }
}
