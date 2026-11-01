import { tabs } from '../../hooks/tabs/tabs.js';
import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import '@symblight/wc-material/tabs';
import { TabConfirmController } from '../../controllers/tab-confirm/TabConfirmController.js';
import { TabContentController } from '../../controllers/tab-content/TabContentController.js';
import '../tab-strip/tab-strip.js';
import '../image-preview/image-preview.js';
import languageIcon from '@material-design-icons/svg/outlined/language.svg?raw';
import '../view-placeholder/view-placeholder.js';
import styles from './tab-view.css?inline';

/** @typedef {import('../../hooks/search/types.js').RevealAt} RevealAt */
/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/sessions/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../hooks/terminals/types.js').TerminalBusyQuery} TerminalBusyQuery */
/** @typedef {import('../tab-strip/tab-strip.js').CloseScope} CloseScope */

/**
 * @tag acp-tab-view
 * @summary The main column's tabs: images, the Browser placeholder and whatever the host renders for the rest (code editors, views).
 * @slot actions Buttons at the end of the strip's row (the terminal panel's add and hide).
 * @fires acp-tab-close `{ id, scope }` A `CloseScope` around the tab, unsaved edits and running programs already confirmed.
 * @fires acp-tab-save `{ id, force: true }` Write over the file although it changed on disk (asked first).
 * @fires acp-tab-reload `{ id }` Drop the tab's edits for the file on disk (asked first).
 */
export class AcpTabView extends LitElement {
  static properties = {
    tabs: { attribute: false },
    active: { attribute: false },
    pinned: { attribute: false },
    root: { attribute: false },
    worktrees: { attribute: false },
    renderContent: { attribute: false },
    terminals: { attribute: false },
    terminalBusy: { attribute: false },
  };

  static styles = styles;

  /** @type {{ id: string, at: RevealAt } | null} Where to put the caret in a tab once it is active and loaded. */
  #pendingLine = null;
  /** @type {TabConfirmController} */
  #confirm = new TabConfirmController(this, {
    tabs: () => this.tabs,
    terminalBusy: () => this.terminalBusy,
  });
  /** @type {TabContentController<EditorTab>} */
  #content = new TabContentController({
    views: {
      code: (tab) => this.#renderFile(tab, () => this.#renderHosted(tab)),
      // The editor until the rendered preview exists: it keeps the diff gutter, comments and selection actions.
      markdown: (tab) => this.#renderFile(tab, () => this.#renderHosted(tab)),
      image: (tab) =>
        this.#renderFile(
          tab,
          () => html`<acp-image-preview class="acp-tab-view__view" path=${tab.path} .image=${tab.image}></acp-image-preview>`,
        ),
      settings: (tab) => this.#renderHosted(tab),
      agents: (tab) => this.#renderHosted(tab),
      changes: (tab) => this.#renderHosted(tab),
      'session-changes': (tab) => this.#renderHosted(tab),
      terminal: (tab) => this.#renderHosted(tab),
      browser: () =>
        html`<acp-view-placeholder
          class="acp-tab-view__view"
          .icon=${languageIcon}
          heading="Browser"
          text="Not implemented yet."
        ></acp-view-placeholder>`,
    },
  });

  constructor() {
    super();
    /** @type {readonly EditorTab[]} In strip order. */
    this.tabs = [];
    /** @type {string | null} The active tab's id. */
    this.active = null;
    /** @type {readonly string[]} Pinned tabs' ids. */
    this.pinned = [];
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {readonly WorktreeFolder[]} Worktree sessions' folders, whose files are marked. */
    this.worktrees = [];
    /** @type {Readonly<Record<string, TerminalInfo>>} Terminal tabs' shells, by terminal id. */
    this.terminals = {};
    /** @type {TerminalBusyQuery} Which terminals run a program other than their shell. */
    this.terminalBusy = async () => [];
    /** @type {((tab: EditorTab) => unknown) | null} The content of the tabs whose view the host owns, as its views render it. */
    this.renderContent = null;
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Puts the caret on a line of a tab, or selects a range there, once it is active and loaded.
   * @param {string} id
   * @param {RevealAt} at
   */
  revealLine(id, at) {
    this.#pendingLine = { id, at };
    this.requestUpdate();
  }

  /** The active code tab's selected text, `''` when none. */
  selectedText() {
    return this.#activeCodeView()?.selectedText() ?? '';
  }

  #activeCodeView() {
    return this.renderRoot.querySelector('.acp-tab-view__panel[active]')?.querySelector('acp-code-view') ?? null;
  }

  /**
   * Asks whether to save an edited tab over its file, which changed on disk, or reload the file;
   * the container calls it when it finds the change only as it saves.
   * @param {string} id
   */
  async confirmOverwrite(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const choice = await this.#confirm.overwrite(tab);
    if (choice === 'confirm') this.#emit('acp-tab-save', { id, force: true });
    else if (choice === 'extra') this.#emit('acp-tab-reload', { id });
  }

  async updated() {
    const pending = this.#pendingLine;
    if (pending === null || pending.id !== this.active || !this.tabs.find((t) => t.id === pending.id)?.loaded) return;
    this.#pendingLine = null;
    // The host's view hands the editor the loaded tab one update after this one.
    const hosted = /** @type {{ updateComplete?: Promise<unknown> } | null | undefined} */ (
      this.renderRoot.querySelector('.acp-tab-view__panel[active] .acp-tab-view__hosted')?.firstElementChild
    );
    await hosted?.updateComplete;
    this.#activeCodeView()?.revealLine(pending.at);
  }

  /** The strip asks to close tabs: confirm what they'd lose first. */
  #onCloseRequest = async (/** @type {Event} */ e) => {
    e.stopPropagation();
    const { id, scope, ids } = /** @type {CustomEvent<{ id: string, scope: CloseScope, ids: string[] }>} */ (e).detail;
    if (!(await this.#confirm.close(ids))) return;
    if (this.active !== null && ids.includes(this.active)) this.#pendingLine = null;
    this.#emit('acp-tab-close', { id, scope });
  };

  /**
   * A file in its view, or the read error in place of it.
   * @param {EditorTab} tab
   * @param {() => unknown} view
   */
  #renderFile(tab, view) {
    return tab.error ? html`<pre class="acp-tab-view__error">${tab.error}</pre>` : view();
  }

  /** A save over a file changed on disk, from its editor: asks whether to overwrite it. */
  #onConflict = (/** @type {Event} */ e) => {
    e.stopPropagation();
    this.confirmOverwrite(/** @type {CustomEvent<{ id: string }>} */ (e).detail.id);
  };

  /**
   * A tab whose view the host renders. The view takes no box, so its component is the grid's one item.
   * @param {EditorTab} tab
   */
  #renderHosted(tab) {
    return html`<div class="acp-tab-view__hosted" @acp-tab-conflict=${this.#onConflict}>${this.renderContent?.(tab) ?? nothing}</div>`;
  }

  /** @param {EditorTab} tab */
  #renderPanel(tab) {
    return html`<md-tab-panel class="acp-tab-view__panel" value=${tab.id} ?active=${tab.id === this.active}>
      ${this.#content.render(tab)}
    </md-tab-panel>`;
  }

  render() {
    return html`
      <div class="acp-tab-view__header">
        <acp-tab-strip
          class="acp-tab-view__strip"
          .tabs=${this.tabs}
          .active=${this.active}
          .pinned=${this.pinned}
          .root=${this.root}
          .worktrees=${this.worktrees}
          .terminals=${this.terminals}
          @acp-tab-activate=${() => (this.#pendingLine = null)}
          @acp-tab-close-request=${this.#onCloseRequest}
        ></acp-tab-strip>
        <slot name="actions"></slot>
      </div>
      ${repeat(this.tabs, (t) => t.id, (t) => this.#renderPanel(t))}
      ${this.#confirm.render()}
    `;
  }
}

customElements.define('acp-tab-view', AcpTabView);
