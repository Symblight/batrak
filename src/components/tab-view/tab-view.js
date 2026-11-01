import { projects } from '../../hooks/projects/projects.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import '@symblight/wc-material/tabs';
import { TabConfirmController } from '../../controllers/tab-confirm/TabConfirmController.js';
import { TabContentController } from '../../controllers/tab-content/TabContentController.js';
import '../tab-strip/tab-strip.js';
import '../code-view/code-view.js';
import '../agents-view/agents-view.js';
import '../changes-review/changes-review.js';
import '../image-preview/image-preview.js';
import '../terminal/terminal.js';
import languageIcon from '@material-design-icons/svg/outlined/language.svg?raw';
import '../view-placeholder/view-placeholder.js';
import styles from './tab-view.css?inline';

/** @typedef {import('../../hooks/search/types.js').RevealAt} RevealAt */
/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/comments/types.js').AgentThread} AgentThread */
/** @typedef {import('../../hooks/comments/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../hooks/git/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/tabs/types.js').FileDiff} FileDiff */
/** @typedef {import('../../hooks/sessions/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../../hooks/terminals/types.js').TerminalInfo} TerminalInfo */
/** @typedef {import('../../hooks/terminals/types.js').TerminalConnect} TerminalConnect */
/** @typedef {import('../../hooks/terminals/types.js').TerminalBusyQuery} TerminalBusyQuery */
/** @typedef {import('../file-tree/file-tree.js').ListDir} ListDir */
/** @typedef {import('../tab-strip/tab-strip.js').CloseScope} CloseScope */
/** @typedef {import('../../controllers/session-changes/SessionChangesController.js').SessionChangesView} SessionChangesView */

/**
 * What the Changes tab shows.
 * @typedef {Object} ChangesReviewData
 * @property {GitChangesView} changes
 * @property {GitRepoView} repo
 * @property {ReadonlySet<string>} selection Files picked for the next commit.
 * @property {ReadonlySet<string>} expanded
 * @property {ReadonlyMap<string, FileDiff>} diffs
 */

/**
 * @tag acp-tab-view
 * @summary The main column's tabs: files in the view their kind needs, and views.
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
    editorFont: { attribute: false },
    editorFontSize: { attribute: false },
    comments: { attribute: false },
    commentFocus: { attribute: false },
    agents: { attribute: false },
    renderContent: { attribute: false },
    agentsView: { attribute: false },
    agentsQuery: { attribute: false },
    agentsPending: { attribute: false },
    agentsSignIns: { attribute: false },
    agentsTerminal: { attribute: false },
    agentsReveal: { attribute: false },
    review: { attribute: false },
    sessionReview: { attribute: false },
    languages: { attribute: false },
    rootId: { attribute: false },
    listDir: { attribute: false },
    terminals: { attribute: false },
    terminalConnect: { attribute: false },
    terminalBusy: { attribute: false },
    droppingTerminal: { attribute: false },
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
      code: (tab) => this.#renderFile(tab, () => this.#renderCode(tab)),
      // The editor until the rendered preview exists: it keeps the diff gutter, comments and selection actions.
      markdown: (tab) => this.#renderFile(tab, () => this.#renderCode(tab)),
      image: (tab) =>
        this.#renderFile(
          tab,
          () => html`<acp-image-preview class="acp-tab-view__view" path=${tab.path} .image=${tab.image}></acp-image-preview>`,
        ),
      settings: (tab) => this.#renderHosted(tab),
      agents: () =>
        html`<acp-agents-view
          class="acp-tab-view__view"
          .view=${this.agentsView}
          .query=${this.agentsQuery}
          .known=${this.agents?.known ?? []}
          .pending=${this.agentsPending}
          .signIns=${this.agentsSignIns}
          .terminalAgents=${this.agentsTerminal}
          .reveal=${this.agentsReveal}
        ></acp-agents-view>`,
      changes: () => this.#renderChanges(),
      'session-changes': (tab) => this.#renderSessionChanges(tab),
      terminal: (tab) => this.#renderTerminal(tab),
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
    /** @type {string | null} The code editor's font family; `null` for its default. */
    this.editorFont = null;
    /** @type {number} px */
    this.editorFontSize = 13;
    /** @type {Readonly<Record<string, readonly AgentThread[]>>} Every file's comments, by absolute path. */
    this.comments = {};
    /** @type {CommentFocus | null} */
    this.commentFocus = null;
    /** @type {import('../../hooks/agents/types.js').AgentList | null} For the Agents tab: the registry agents its add form offers. */
    this.agents = null;
    /** @type {import('../../hooks/agents/types.js').AgentsView | null} For the Agents tab. */
    this.agentsView = null;
    /** @type {import('../../hooks/agents/types.js').AgentsQuery} For the Agents tab. */
    this.agentsQuery = { query: '', filter: 'all' };
    /** @type {{ updating: readonly string[], checking: boolean }} For the Agents tab: calls this window waits for. */
    this.agentsPending = { updating: [], checking: false };
    /** @type {Readonly<Record<string, import('../../hooks/agents/types.js').SignInRun>>} For the Agents tab: sign-ins running or failed, by agent. */
    this.agentsSignIns = {};
    /** @type {readonly string[]} For the Agents tab: the agents whose sessions open in the terminal. */
    this.agentsTerminal = [];
    /** @type {import('../../hooks/agents/types.js').AgentsReveal | null} For the Agents tab. */
    this.agentsReveal = null;
    /** @type {ChangesReviewData | null} For the Changes tab. */
    this.review = null;
    /** @type {SessionChangesView | null} For the active worktree session's Changes tab. */
    this.sessionReview = null;
    /** @type {Readonly<Record<string, string>>} Languages picked for files, by absolute path. */
    this.languages = {};
    /** @type {string | null} The project's snapshot id, for `listDir`; `null` while none is open. */
    this.rootId = null;
    /** @type {ListDir} Lists a project folder for a footer crumb. */
    this.listDir = async () => [];
    /** @type {Readonly<Record<string, TerminalInfo>>} Terminal tabs' shells, by terminal id. */
    this.terminals = {};
    /** @type {TerminalConnect | null} Streams a terminal tab's shell. */
    this.terminalConnect = null;
    /** @type {TerminalBusyQuery} Which terminals run a program other than their shell. */
    this.terminalBusy = async () => [];
    /** @type {string | null} The terminal files dragged from the OS are over. */
    this.droppingTerminal = null;
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
   * Scrolls the Changes tab to a changed file; the tab must be open.
   * @param {string} path Absolute.
   */
  async revealChange(path) {
    await this.updateComplete;
    const rel = projects.rel(this.root, path);
    if (rel !== null) this.renderRoot.querySelector('acp-changes-review')?.scrollToChange(rel);
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

  updated() {
    const pending = this.#pendingLine;
    if (pending === null || pending.id !== this.active || !this.tabs.find((t) => t.id === pending.id)?.loaded) return;
    this.#pendingLine = null;
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

  /** @param {EditorTab} tab */
  #renderCode(tab) {
    return html`<acp-code-view
      class="acp-tab-view__code"
      .tab=${tab}
      .language=${this.languages[tab.path] ?? ''}
      .root=${this.root}
      .rootId=${this.rootId}
      .worktrees=${this.worktrees}
      .listDir=${this.listDir}
      .editorFont=${this.editorFont}
      .editorFontSize=${this.editorFontSize}
      .comments=${this.comments}
      .commentFocus=${this.commentFocus}
      @acp-tab-conflict=${(/** @type {CustomEvent<{ id: string }>} */ e) => {
        e.stopPropagation();
        this.confirmOverwrite(e.detail.id);
      }}
    ></acp-code-view>`;
  }

  #renderChanges() {
    const review = this.review;
    if (!review) return nothing;
    return html`<acp-changes-review
      class="acp-tab-view__view"
      .changes=${review.changes}
      .repo=${review.repo}
      .selection=${review.selection}
      .expanded=${review.expanded}
      .diffs=${review.diffs}
      .root=${this.root}
      .comments=${this.comments}
      .commentFocus=${this.commentFocus}
    ></acp-changes-review>`;
  }

  /** @param {EditorTab} tab */
  #renderSessionChanges(tab) {
    const review = this.sessionReview;
    if (!review || review.sessionId !== tabs.sessionOf(tab.id)) return nothing;
    return html`<acp-changes-review
      class="acp-tab-view__view"
      .changes=${review.changes}
      .expanded=${review.expanded}
      .diffs=${review.diffs}
      .root=${review.folder}
      .base=${review.base}
      .branch=${review.branch}
      .comments=${this.comments}
      .commentFocus=${this.commentFocus}
    ></acp-changes-review>`;
  }

  /** @param {EditorTab} tab */
  #renderTerminal(tab) {
    const id = tabs.terminalOf(tab.id);
    const info = id === null ? undefined : this.terminals[id];
    if (!info) return nothing;
    return html`<acp-terminal
      class="acp-tab-view__view"
      terminal-id=${id}
      .connect=${this.terminalConnect}
      .info=${info}
      .fontFamily=${this.editorFont}
      .fontSize=${this.editorFontSize}
      ?dropping=${id === this.droppingTerminal}
    ></acp-terminal>`;
  }

  /**
   * A tab whose view the host renders. The view takes no box, so its component is the grid's one item.
   * @param {EditorTab} tab
   */
  #renderHosted(tab) {
    return html`<div class="acp-tab-view__hosted">${this.renderContent?.(tab) ?? nothing}</div>`;
  }

  /** @param {EditorTab} tab */
  #renderPanel(tab) {
    return html`<md-tab-panel class="acp-tab-view__panel" value=${tab.id} ?active=${tab.id === this.active}>
      ${this.#content.render(tab)}
    </md-tab-panel>`;
  }

  render() {
    return html`
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
      ${repeat(this.tabs, (t) => t.id, (t) => this.#renderPanel(t))}
      ${this.#confirm.render()}
    `;
  }
}

customElements.define('acp-tab-view', AcpTabView);
