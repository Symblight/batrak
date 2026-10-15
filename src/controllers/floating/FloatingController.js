import { autoUpdate, computePosition } from '@floating-ui/dom';

/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('@floating-ui/dom').ReferenceElement} ReferenceElement */
/** @typedef {import('@floating-ui/dom').Placement} Placement */
/** @typedef {import('@floating-ui/dom').Middleware} Middleware */

/**
 * @typedef {Object} FloatingConfig
 * @property {() => HTMLElement | null} floating The floating element as rendered now; `null` when none is.
 * @property {() => ReferenceElement | null} reference What it's anchored to: an element, or a virtual
 *   one (a caret's rect). Return the same object while the anchor is the same: a new one restarts tracking.
 * @property {Placement} [placement] Default `bottom-start`.
 * @property {Middleware[]} [middleware] With `hide()` in it, the floating element is hidden while its
 *   reference is scrolled out of view.
 */

/**
 * Keeps a floating element of the host anchored to a reference with Floating UI: `position: fixed`
 * coordinates written on the element, recomputed on every scroll, resize and layout change
 * (`autoUpdate`) while both exist. Checked after every host update.
 * @implements {ReactiveController}
 */
export class FloatingController {
  /** @type {FloatingConfig} */
  #config;
  /** @type {HTMLElement | null} */
  #floating = null;
  /** @type {ReferenceElement | null} */
  #reference = null;
  /** @type {(() => void) | null} Stops `autoUpdate`. */
  #cleanup = null;

  /**
   * @param {ReactiveControllerHost} host
   * @param {FloatingConfig} config
   */
  constructor(host, config) {
    this.#config = config;
    host.addController(this);
  }

  hostUpdated() {
    const floating = this.#config.floating();
    const reference = floating ? this.#config.reference() : null;
    if (floating === this.#floating && reference === this.#reference) return;
    this.#stop();
    if (!floating || !reference) return;
    this.#floating = floating;
    this.#reference = reference;
    floating.style.visibility = 'hidden'; // until placed: no frame at 0,0
    this.#cleanup = autoUpdate(reference, floating, () => this.#place(reference, floating));
  }

  hostDisconnected() {
    this.#stop();
  }

  #stop() {
    this.#cleanup?.();
    this.#cleanup = null;
    this.#floating = null;
    this.#reference = null;
  }

  /**
   * @param {ReferenceElement} reference
   * @param {HTMLElement} floating
   */
  async #place(reference, floating) {
    const { x, y, middlewareData } = await computePosition(reference, floating, {
      strategy: 'fixed',
      placement: this.#config.placement ?? 'bottom-start',
      middleware: this.#config.middleware,
    });
    if (floating !== this.#floating) return; // replaced meanwhile
    floating.style.left = `${x}px`;
    floating.style.top = `${y}px`;
    floating.style.visibility = middlewareData.hide?.referenceHidden ? 'hidden' : '';
  }
}
