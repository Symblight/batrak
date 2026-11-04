import { projects } from '../../hooks/projects/projects.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import { tabs } from '../../hooks/tabs/tabs.js';

/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/terminals/types.js').TerminalBusyQuery} TerminalBusyQuery */
/** @typedef {import('../../hooks/app/types.js').ConfirmChoice} ConfirmChoice */

/**
 * @typedef {Object} TabConfirmConfig
 * @property {() => readonly EditorTab[]} tabs The host's tabs.
 * @property {() => TerminalBusyQuery} terminalBusy Which terminals run a program other than their shell.
 * @property {() => HTMLElementTagNameMap['acp-confirm-dialog']} dialog The dialog they're asked in, rendered by the view above the host.
 */

/**
 * The questions asked before tabs lose work: closing unsaved edits or a running program, saving
 * over a file changed on disk.
 * Has no lifecycle, so it isn't added to the host as a `ReactiveController`.
 */
export class TabConfirmController {
  /** @type {TabConfirmConfig} */
  #config;

  /**
   * @param {TabConfirmConfig} config
   */
  constructor(config) {
    this.#config = config;
  }

  get #dialog() {
    return this.#config.dialog();
  }

  /**
   * `true` when tabs may close: none has unsaved edits or runs a program, or the user lets them go.
   * @param {readonly string[]} ids Tabs about to close.
   */
  async close(ids) {
    return (await this.#confirmDiscard(ids)) && (await this.#confirmTerminate(ids));
  }

  /** @param {readonly string[]} ids */
  async #confirmDiscard(ids) {
    const dirty = this.#config.tabs().filter((t) => ids.includes(t.id) && t.draft !== null);
    if (!dirty.length) return true;
    return this.#dialog.confirm({
      headline: 'Discard unsaved changes?',
      message: dirty.map((t) => projects.basename(t.path)).join(', ') + (dirty.length > 1 ? ' have' : ' has') + ' unsaved changes.',
      detail: `Press ${shortcuts.hint('save')} in the editor to save.`,
      confirmLabel: 'Discard',
      destructive: true,
    });
  }

  /** @param {readonly string[]} ids */
  async #confirmTerminate(ids) {
    const terminals = ids.map(tabs.terminalOf).filter(/** @returns {t is string} */ (t) => t !== null);
    if (!terminals.length) return true;
    const busy = await this.#config.terminalBusy()(terminals);
    if (!busy.length) return true;
    return this.#dialog.confirm({
      headline: busy.length === 1 ? `Terminate ${busy[0].process}?` : `Terminate ${busy.length} running programs?`,
      message:
        busy.length === 1
          ? `${busy[0].process} is still running in the terminal.`
          : `${busy.map((b) => b.process).join(', ')} are still running in their terminals.`,
      confirmLabel: 'Terminate',
      destructive: true,
    });
  }

  /**
   * Asks whether to save an edited tab over its file, which changed on disk (`confirm`), or reload
   * the file (`extra`).
   * @param {EditorTab} tab
   * @returns {Promise<ConfirmChoice>}
   */
  overwrite(tab) {
    return this.#dialog.choose({
      headline: `${projects.basename(tab.path)} changed on disk`,
      message: 'It was changed since you started editing it, by an agent or another program.',
      detail: 'Overwrite replaces that change with your edits; Reload drops your edits.',
      confirmLabel: 'Overwrite',
      extraLabel: 'Reload',
      destructive: true,
    });
  }
}
