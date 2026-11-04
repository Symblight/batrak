import { html } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { app } from '../../hooks/app/app.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { $terminalFocus, $terminalTabs, $terminals, terminalFocused, terminalGroup } from '../../stores/terminals/terminals.js';
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
 * @summary The terminal panel: the shown project's terminals as tabs in a tab view, every one mounted and the active one in front, with the buttons to add one and hide the panel.
 */
export class AcpTerminalsView extends ViewElement {
  #terminalTabs = new StoreController(this, { store: $terminalTabs });
  #terminals = new StoreController(this, { store: $terminals });
  #project = new StoreController(this, { store: $project });
  #focus = new StoreController(this, { store: $terminalFocus, onChange: (request) => request && this.#focusTerminal(request) });

  /** @type {Map<string, HTMLElementTagNameMap['acp-terminal-view']>} The terminals mounted, by terminal id. */
  #mounted = new Map();
  /** @type {readonly string[] | null} The ids `#tabs` was made from. */
  #tabsFor = null;
  /** @type {readonly EditorTab[]} */
  #tabs = [];

  /**
   * Focuses the terminal a request names, if it is mounted, and answers the request.
   * @param {{ terminalId: string }} request
   */
  async #focusTerminal(request) {
    await this.updateComplete;
    this.#mounted.get(request.terminalId)?.focus();
    terminalFocused(request);
  }

  /** @param {readonly string[]} paths @returns {readonly EditorTab[]} The same array until the tabs change, as the tab strip re-measures on a new one. */
  #tabsOf(paths) {
    if (paths !== this.#tabsFor) {
      this.#tabsFor = paths;
      this.#tabs = paths.map(terminals.terminalTab);
    }
    return this.#tabs;
  }

  /**
   * @param {string} id
   * @param {Element | undefined} view
   */
  #track(id, view) {
    if (view) this.#mounted.set(id, /** @type {HTMLElementTagNameMap['acp-terminal-view']} */ (view));
    else this.#mounted.delete(id);
  }

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
    const id = tabs.terminalOf(tab.id) ?? '';
    return html`<acp-terminal-view terminal-id=${id} ${ref((view) => this.#track(id, view))}></acp-terminal-view>`;
  };

  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-confirm-dialog']>} A ref: a tab's view can hold a dialog of its own. */
  #confirmDialogRef = createRef();
  #confirmDialog = () => /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.#confirmDialogRef.value);

  render() {
    const { paths, active, pinned } = this.#terminalTabs.value;
    return html`<acp-panel>
      <acp-tab-view
        .tabs=${this.#tabsOf(paths)}
        .active=${active}
        .pinned=${pinned}
        .root=${this.#project.value?.path ?? null}
        .terminals=${this.#terminals.value}
        .terminalBusy=${terminals.busy}
        .confirmDialog=${this.#confirmDialog}
        .renderContent=${this.#renderTerminal}
        .dropTo=${tabs.editorDrop}
        @acp-tab-activate=${(/** @type {CustomEvent<{ id: string }>} */ e) => terminalGroup.activate(e.detail.id)}
        @acp-tab-close=${this.#onTabClose}
        @acp-tab-pin=${(/** @type {CustomEvent<{ id: string, pinned: boolean }>} */ e) => terminalGroup.setPinned(e.detail.id, e.detail.pinned)}
        @acp-tab-move=${(/** @type {CustomEvent<{ id: string, index: number }>} */ e) => terminalGroup.move(e.detail.id, e.detail.index)}
      >
        <acp-terminal-action slot="add" action="new" @acp-terminal-new=${() => this.#newTerminal()}></acp-terminal-action>
        <acp-terminal-action slot="actions" action="hide" @acp-terminal-hide=${() => terminals.hidePanel()}></acp-terminal-action>
      </acp-tab-view>
    </acp-panel>
      <acp-confirm-dialog ${ref(this.#confirmDialogRef)}></acp-confirm-dialog>`;
  }
}

customElements.define('acp-terminals-view', AcpTerminalsView);
