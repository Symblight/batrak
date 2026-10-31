import { StoreController } from '../store/StoreController.js';
import { cancelSearch, findInFiles } from '../../services/ipc.js';
import { $rootId } from '../../stores/workspace.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('../../models/types.js').SearchEvent} SearchEvent */
/** @typedef {import('../../models/types.js').SearchOptions} SearchOptions */
/** @typedef {import('../../models/types.js').SearchFileResult} SearchFileResult */
/** @typedef {import('../../models/types.js').SearchErrorSource} SearchErrorSource */

/**
 * @typedef {Object} FindInFilesConfig
 * @property {'panel' | 'dialog'} slot The backend search slot: a new search cancels only its own.
 */

/**
 * Find in Files over the open project's snapshot: results streamed in by file, one render a frame.
 * Runs only while `active`; a newer search, or a newly opened folder, replaces it.
 * @implements {ReactiveController}
 */
export class FindInFilesController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {FindInFilesConfig} */
  #config;
  /** Id of the current search; events of older ones are dropped. */
  #generation = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #debounce = undefined;
  /** @type {SearchFileResult[]} Results received since the last render. */
  #incoming = [];
  /** Pending animation frame that flushes `#incoming`. */
  #frame = 0;
  /** The Find in Files pane is shown. */
  #active = false;
  /** @type {SearchOptions} */
  #options = { query: '', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };
  /** @type {StoreController<string | null>} */
  #rootId;

  /** @type {readonly SearchFileResult[]} */
  results = [];
  searching = false;
  limitHit = false;
  error = '';
  /** @type {SearchErrorSource | null} What the error is about; `null` without one, or for a failed call. */
  errorSource = null;

  /**
   * @param {ReactiveControllerHost & HTMLElement} host
   * @param {FindInFilesConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    // Re-runs the search in a newly opened folder.
    this.#rootId = new StoreController(host, { store: $rootId, onChange: () => this.#schedule(0) });
    host.addController(this);
  }

  hostDisconnected() {
    this.#cancel();
  }

  /**
   * Hidden, the search stops; shown again, it runs again.
   * @param {boolean} active
   */
  setActive(active) {
    if (active === this.#active) return;
    this.#active = active;
    if (active) this.#schedule(0);
    else this.#cancel();
  }

  /**
   * (Re)starts the search for `options` after `delay` ms.
   * @param {SearchOptions} options
   * @param {number} delay
   */
  search(options, delay) {
    this.#options = options;
    this.#schedule(delay);
  }

  /** @param {number} delay */
  #schedule(delay) {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => this.#search(), delay);
  }

  /** Stops the running search; its late events are ignored. */
  #cancel() {
    clearTimeout(this.#debounce);
    this.#generation++;
    this.#set({ searching: false });
    const rootId = this.#rootId.value;
    if (rootId) cancelSearch(rootId, this.#config.slot).catch(() => {});
  }

  /** @param {Partial<Pick<FindInFilesController, 'results' | 'searching' | 'limitHit' | 'error' | 'errorSource'>>} changes */
  #set(changes) {
    Object.assign(this, changes);
    this.#host.requestUpdate();
  }

  /** Starts a search for the current options, replacing any previous results. */
  async #search() {
    const generation = ++this.#generation;
    const rootId = this.#rootId.value;
    this.#incoming = [];
    this.#set({ results: [], limitHit: false, error: '', errorSource: null });
    if (!this.#active || rootId === null || this.#options.query === '') {
      this.#set({ searching: false });
      if (rootId !== null) cancelSearch(rootId, this.#config.slot).catch(() => {});
      return;
    }
    this.#set({ searching: true });
    try {
      await findInFiles(rootId, this.#config.slot, this.#options, (event) => {
        if (generation === this.#generation) this.#onEvent(event);
      });
    } catch (err) {
      if (generation === this.#generation) this.#set({ searching: false, error: String(err) });
    }
  }

  /** @param {SearchEvent} event */
  #onEvent(event) {
    if (event.kind === 'file') {
      // Batch messages into one render per frame.
      this.#incoming.push({ path: event.path, matches: event.matches });
      this.#frame ||= requestAnimationFrame(() => {
        this.#frame = 0;
        this.#set({ results: [...this.results, ...this.#incoming] });
        this.#incoming = [];
      });
    } else if (event.kind === 'done') {
      this.#set({ searching: false, limitHit: event.limitHit });
    } else {
      this.#set({ searching: false, error: event.message, errorSource: event.source });
    }
  }
}
