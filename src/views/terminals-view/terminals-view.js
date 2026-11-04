import { html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { createRef, ref } from 'lit/directives/ref.js';
import { app } from '../../hooks/app/app.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { $folderTerminalTabs, $terminals, focusTerminal, terminalGroup } from '../../stores/terminals/terminals.js';
import { NO_PROJECT, NO_TABS } from '../../stores/tab-group/tab-group.js';
import { $shownFolder } from '../../stores/workspaces/workspaces.js';
import { $project } from '../../stores/project/project.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/panel/panel.js';
import '../../components/tab-view/tab-view.js';
import '../../components/terminal-action/terminal-action.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../terminal-view/terminal-view.js';

/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../components/tab-strip/tab-strip.js').CloseScope} CloseScope */

/**
 * @tag acp-terminals-view
 * @summary The terminal panel: a tab view per folder, kept mounted so its terminals keep their screens, the shown folder's in front, with the buttons to add a terminal and hide the panel.
 */
export class AcpTerminalsView extends ViewElement {
  #folderTabs = new StoreController(this, { store: $folderTerminalTabs });
  #shownFolder = new StoreController(this, { store: $shownFolder });
  #terminals = new StoreController(this, { store: $terminals });
  #project = new StoreController(this, { store: $project });

  /** @type {WeakMap<readonly string[], readonly EditorTab[]>} The tabs made from each folder's ids. */
  #tabs = new WeakMap();

  /** @param {readonly string[]} paths @returns {readonly EditorTab[]} The same array until the tabs change, as the tab strip re-measures on a new one. */
  #tabsOf(paths) {
    let tabList = this.#tabs.get(paths);
    if (!tabList) {
      tabList = paths.map(terminals.terminalTab);
      this.#tabs.set(paths, tabList);
    }
    return tabList;
  }

  /** A tab clicked is shown and takes the keyboard. */
  #onTabActivate = (/** @type {CustomEvent<{ id: string }>} */ e) => {
    terminalGroup.activate(e.detail.id);
    focusTerminal(tabs.terminalOf(e.detail.id) ?? '');
  };

  /** @param {Event} e */
  #onTabClose(e) {
    const { id, scope } = /** @type {CustomEvent<{ id: string, scope: CloseScope }>} */ (e).detail;
    if (scope === 'tab') terminalGroup.close(id);
    else if (scope === 'others') terminalGroup.closeOthers(id);
    else if (scope === 'right') terminalGroup.closeToRight(id);
    else terminalGroup.closeAll();
  }

  #newTerminal() {
    terminals.newTerminal().catch((err) => app.reportError('Opening a terminal failed', err));
  }

  /** @param {EditorTab} tab */
  #renderTerminal = (tab) => {
    return html`<acp-terminal-view terminal-id=${tabs.terminalOf(tab.id) ?? ''}></acp-terminal-view>`;
  };

  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-confirm-dialog']>} A ref: a tab's view can hold a dialog of its own. */
  #confirmDialogRef = createRef();
  #confirmDialog = () => /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.#confirmDialogRef.value);

  /**
   * @param {string} folder Its key in the per-folder stores.
   * @param {string} shown The shown folder's.
   */
  #renderFolder(folder, shown) {
    const { paths, active, pinned } = this.#folderTabs.value[folder] ?? NO_TABS;
    return html`<acp-tab-view
      ?hidden=${folder !== shown}
      .tabs=${this.#tabsOf(paths)}
      .active=${active}
      .pinned=${pinned}
      .root=${this.#project.value?.path ?? null}
      .terminals=${this.#terminals.value}
      .terminalBusy=${terminals.busy}
      .confirmDialog=${this.#confirmDialog}
      .renderContent=${this.#renderTerminal}
      .dropTo=${tabs.editorDrop}
      @acp-tab-activate=${this.#onTabActivate}
      @acp-tab-close=${this.#onTabClose}
      @acp-tab-pin=${(/** @type {CustomEvent<{ id: string, pinned: boolean }>} */ e) => terminalGroup.setPinned(e.detail.id, e.detail.pinned)}
      @acp-tab-move=${(/** @type {CustomEvent<{ id: string, index: number }>} */ e) => terminalGroup.move(e.detail.id, e.detail.index)}
    >
      <acp-terminal-action slot="add" action="new" @acp-terminal-new=${() => this.#newTerminal()}></acp-terminal-action>
      <acp-terminal-action slot="actions" action="hide" @acp-terminal-hide=${() => terminals.hidePanel()}></acp-terminal-action>
    </acp-tab-view>`;
  }

  render() {
    const shown = this.#shownFolder.value ?? NO_PROJECT;
    const open = Object.keys(this.#folderTabs.value).filter((folder) => this.#folderTabs.value[folder]?.paths.length);
    const folders = open.includes(shown) ? open : [...open, shown];
    return html`<acp-panel>${repeat(folders, (folder) => folder, (folder) => this.#renderFolder(folder, shown))}</acp-panel>
      <acp-confirm-dialog ${ref(this.#confirmDialogRef)}></acp-confirm-dialog>`;
  }
}

customElements.define('acp-terminals-view', AcpTerminalsView);
