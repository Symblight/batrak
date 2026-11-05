/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */

/**
 * @template T
 * @typedef {Object} StoreControllerConfig
 * @property {import('nanostores').ReadableAtom<T>} store
 * @property {(value: T, oldValue: T | undefined) => void} [onChange] Side effect run before the
 *   re-render, on connect (`oldValue` undefined) and on every change after.
 */

/**
 * Subscribes its host to a nanostores store while connected: re-renders the host on every change and
 * exposes the store's current `value`.
 * @template T
 * @implements {ReactiveController}
 */
export class StoreController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {StoreControllerConfig<T>} */
  #config;
  /** @type {(() => void) | null} */
  #unsubscribe = null;

  /**
   * @param {ReactiveControllerHost} host
   * @param {StoreControllerConfig<T>} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    host.addController(this);
  }

  /** @returns {T} */
  get value() {
    return this.#config.store.get();
  }

  hostConnected() {
    this.#unsubscribe = this.#config.store.subscribe((value, oldValue) => {
      this.#config.onChange?.(/** @type {T} */ (value), /** @type {T | undefined} */ (oldValue));
      this.#host.requestUpdate();
    });
  }

  hostDisconnected() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
