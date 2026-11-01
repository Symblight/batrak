import { buildChipElement } from '@symblight/chat';
import { ChxCommandPicker } from '@symblight/chat/composer';
import { buildBrowseItem, buildEntryItem, fileChipAttrs } from './chips.js';

/** @typedef {import('lit').ReactiveControllerHost & HTMLElement} FileMentionsHost */
/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {Parameters<ChxCommandPicker['resolve']>[0]} MenuItemElement */
/** @typedef {import('../../models/types/types.js').QuickOpenItem} QuickOpenItem */

/**
 * @typedef {Object} FileMentionsConfig
 * @property {() => ChxCommandPicker | null} picker The composer's `@` picker.
 * @property {() => HTMLElement | null} composer The composer, which keeps focus while the menu searches.
 * @property {() => readonly QuickOpenItem[]} options The host's answer to the last `onQuery`.
 * @property {(query: string | null) => void} onQuery Files and folders for `@` to search for; `null` drops the search.
 */

/** How many answers the `@` menu lists. */
const MAX_OPTIONS = 50;

/**
 * The composer's `@` mentions: the menu offers "Files and Folders" until it is picked or a name is
 * typed, then lists the files and folders the host answers a query with; a pick becomes a chip
 * with its name and icon, the path in `data-path`.
 * @implements {ReactiveController}
 */
export class FileMentionsController {
  /** @type {FileMentionsConfig} */
  #config;
  /** The `@` query being typed, `null` when none is. */
  #query = /** @type {string | null} */ (null);
  /** Whether "Files and Folders" was picked for this `@`: then the query searches. */
  #browsing = false;
  /** Whether the option being resolved is a folder; `chx-command-picked` only carries its value. */
  #pickingFolder = false;
  /** @type {readonly QuickOpenItem[] | null} The answer last listed. */
  #listed = null;

  /**
   * @param {FileMentionsHost} host
   * @param {FileMentionsConfig} config
   */
  constructor(host, config) {
    this.#config = config;
    host.addController(this);
  }

  /** Lists a new answer when the menu is searching. */
  hostUpdated() {
    const options = this.#config.options();
    if (options === this.#listed) return;
    this.#listed = options;
    const picker = this.#config.picker();
    if (!this.#searching || !picker) return;
    picker.clearOptions();
    const items = document.createDocumentFragment();
    for (const item of options.slice(0, MAX_OPTIONS)) items.append(buildEntryItem(item));
    picker.addOptions(items);
  }

  /** Whether the menu shows search results, rather than nothing or "Files and Folders". */
  get #searching() {
    return this.#query !== null && (this.#browsing || this.#query !== '');
  }

  /** @param {ChxCommandPicker} picker */
  #show(picker) {
    const query = this.#query;
    if (!this.#searching) {
      this.#config.onQuery(null);
      picker.clearOptions();
      if (query === null) return;
      const options = document.createDocumentFragment();
      options.append(buildBrowseItem());
      picker.addOptions(options);
      return;
    }
    this.#config.onQuery(query);
  }

  /** `chx-command-query`: "Files and Folders" until it's picked or a name is typed, then files and folders by name. */
  onQuery = (/** @type {Event} */ e) => {
    this.#query = /** @type {CustomEvent<{ value: string | null }>} */ (e).detail.value;
    if (this.#query === null) this.#browsing = false;
    this.#show(/** @type {ChxCommandPicker} */ (e.target));
  };

  /**
   * Replaces the picker's `resolve`: "Files and Folders" opens the search instead of inserting a chip.
   * @param {MenuItemElement} option
   */
  resolve = (option) => {
    const picker = this.#config.picker();
    if (!picker) return;
    if (option.dataset.browse === undefined) {
      this.#pickingFolder = option.dataset.kind === 'folder';
      ChxCommandPicker.prototype.resolve.call(picker, option);
      return;
    }
    this.#browsing = true;
    this.#show(picker);
    // A click on the option moved focus into the menu; keep typing in the composer.
    this.#config.composer()?.focus();
  };

  /** `chx-command-picked`: turns a picked file or folder into a chip. */
  onPicked = (/** @type {Event} */ e) => {
    const { value, setChip } = /** @type {CustomEvent<{ value: string, setChip: (chip: HTMLElement) => void }>} */ (e).detail;
    setChip(buildChipElement(fileChipAttrs(value, this.#pickingFolder)));
  };
}
