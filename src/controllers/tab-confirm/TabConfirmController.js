import { projects } from '../../hooks/projects/projects.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { html } from 'lit';
import '../../components/confirm-dialog/confirm-dialog.js';

/** @typedef {import('lit').ReactiveControllerHost & import('lit').LitElement} ReactiveElementHost */
/** @typedef {import('../../models/types/types.js').EditorTab} EditorTab */
/** @typedef {import('../../models/types/types.js').TerminalBusyQuery} TerminalBusyQuery */
/** @typedef {import('../../models/types/types.js').ConfirmChoice} ConfirmChoice */

/**
 * @typedef {Object} TabConfirmConfig
 * @property {() => readonly EditorTab[]} tabs The host's tabs.
 * @property {() => TerminalBusyQuery} terminalBusy Which terminals run a program other than their shell.
 */

/**
 * The questions asked before tabs lose work: closing unsaved edits or a running program, saving
 * over a file changed on disk. The host renders `controller.render()`, the dialog they're asked in.
 * Has no lifecycle, so it isn't added to the host as a `ReactiveController`.
 */
export class TabConfirmController {
  /** @type {ReactiveElementHost} */
  #host;
  /** @type {TabConfirmConfig} */
  #config;

  /**
   * @param {ReactiveElementHost} host
   * @param {TabConfirmConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
  }

  get #dialog() {
    return /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.#host.renderRoot.querySelector('acp-confirm-dialog')
    );
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
      detail: 'Press ⌘S / Ctrl+S in the editor to save.',
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

  render() {
    return html`<acp-confirm-dialog></acp-confirm-dialog>`;
  }
}
