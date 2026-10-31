import { projects } from '../../hooks/projects/projects.js';
import { settings as settingsHook } from '../../hooks/settings/settings.js';
import { app } from '../../hooks/app/app.js';
import { html } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import { commentAuthor } from '../../models/editor-plugins/editor-plugins.js';
import { composedContains } from '../../models/file-drop/file-drop.js';
import { shellPaths } from '../../models/shell-paths/shell-paths.js';
import { agentConfig } from '../../services/agent-config/agent-config.js';
import { listDir, openUrl } from '../../services/ipc/ipc.js';
import { fileDrop } from '../../services/file-drop/file-drop.js';
import { terminalController } from '../../services/terminals/terminals.js';
import { sessionController } from '../../services/session-controller/session-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { TabFilesController } from '../../controllers/tab-files/TabFilesController.js';
import { ChangesReviewController } from '../../controllers/changes-review/ChangesReviewController.js';
import { SessionChangesController } from '../../controllers/session-changes/SessionChangesController.js';
import {
  $activePath,
  $agentsReveal,
  $editorTabs,
  $fileLanguages,
  $settingsReveal,
  AGENTS_TAB_ID,
  CHANGES_TAB_ID,
  SETTINGS_TAB_ID,
  activateTab,
  agentsRevealed,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  moveTab,
  openChanges as openChangesTab,
  openSettings as openSettingsTab,
  openTab,
  setFileLanguage,
  setTabPinned,
  settingsRevealed,
} from '../../stores/editor/editor.js';
import { $agentList, $agentsPending, $agentsQuery, $agentsView, $signIns, signInsOf } from '../../stores/agents/agents.js';
import { $agentViews, setAgentView } from '../../stores/session-views/session-views.js';
import { addToChat } from '../../stores/chat/chat.js';
import {
  $commentFocus,
  $comments,
  $tabComments,
  addComment,
  deleteComment,
  editComment,
  focusComment,
  sendToChat,
} from '../../stores/comments/comments.js';
import { $systemFonts } from '../../stores/fonts/fonts.js';
import { $commitSelection, $gitChanges, $gitRepo, pickForCommit, setCommitSelection } from '../../stores/git/git.js';
import {
  $settings,
  resetSection,
  setAccent,
  setAppearance,
  setEditorFont,
  setEditorFontSize,
} from '../../stores/settings/settings.js';
import { $worktrees } from '../../stores/sessions/sessions.js';
import { $terminals, setTerminalTitle } from '../../stores/terminals/terminals.js';
import { $fileDropTarget } from '../../stores/file-drop/file-drop.js';
import { $rootId, $workspace } from '../../stores/workspace/workspace.js';
import '../../components/tab-view/tab-view.js';
import { AcpTerminal } from '../../components/terminal/terminal.js';
import '../../components/comment-bar/comment-bar.js';

/** @typedef {import('../../models/types/types.js').RevealAt} RevealAt */
/** @typedef {import('../../models/types/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types/types.js').FileDrop} FileDrop */
/** @typedef {import('../../models/types/types.js').NewAgent} NewAgent */
/** @typedef {import('../../models/types/types.js').SettingsReveal} SettingsReveal */
/** @typedef {import('../../models/types/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../models/types/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../models/types/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../models/types/types.js').Settings} Settings */
/** @typedef {import('../../models/types/types.js').SessionView} SessionView */
/** @typedef {import('../../stores/settings/rules.js').SettingsSection} SettingsSection */
/** @typedef {import('../../components/tab-strip/tab-strip.js').CloseScope} CloseScope */
/** @typedef {Parameters<typeof addComment>[1]} CommentDraft */

/**
 * @tag acp-main-column
 * @summary The main column: everything opens in its tabs (files, Changes, Settings, terminals).
 */
export class AcpMainColumn extends ViewElement {
  #files = new TabFilesController(this);
  #review = new ChangesReviewController(this);
  #sessionReview = new SessionChangesController(this);
  #editorTabs = new StoreController(this, { store: $editorTabs });
  #fileLanguages = new StoreController(this, { store: $fileLanguages });
  #workspace = new StoreController(this, { store: $workspace });
  #rootId = new StoreController(this, { store: $rootId });
  #worktrees = new StoreController(this, { store: $worktrees });
  #settings = new StoreController(this, { store: $settings });
  #systemFonts = new StoreController(this, { store: $systemFonts });
  #agentList = new StoreController(this, { store: $agentList });
  #settingsReveal = new StoreController(this, { store: $settingsReveal });
  #agentsView = new StoreController(this, { store: $agentsView });
  #agentsQuery = new StoreController(this, { store: $agentsQuery });
  #agentsPending = new StoreController(this, { store: $agentsPending });
  #agentsReveal = new StoreController(this, { store: $agentsReveal });
  #signIns = new StoreController(this, { store: $signIns });
  #agentViews = new StoreController(this, { store: $agentViews });
  #comments = new StoreController(this, { store: $comments });
  #tabComments = new StoreController(this, { store: $tabComments });
  #gitChanges = new StoreController(this, { store: $gitChanges });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #commitSelection = new StoreController(this, { store: $commitSelection });
  #terminals = new StoreController(this, { store: $terminals });
  #fileDropTarget = new StoreController(this, { store: $fileDropTarget });

  /** A comment to reveal: show its file; the editor that shows it then reveals it. */
  #commentFocus = new StoreController(this, {
    store: $commentFocus,
    onChange: (focus) => {
      if (focus) this.#showFile(focus.path);
    },
  });

  /**
   * The bar sits lower in the Changes tab, which has no footer. Settings lists the fonts, and the
   * agents with the versions they reported since; the Agents tab asks again too.
   */
  #activePath = new StoreController(this, {
    store: $activePath,
    onChange: (path) => {
      if (path === AGENTS_TAB_ID) agentConfig.search();
      if (path !== SETTINGS_TAB_ID) return;
      settingsHook.loadSystemFonts();
      agentConfig.refresh();
    },
  });

  #onFileOpen = (/** @type {Event} */ e) => {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.openFile(path, line);
  };

  /**
   * @param {Element | null} target
   * @returns {AcpTerminal | null} A terminal tab's, when `target` is one.
   */
  #ownTerminal(target) {
    return target instanceof AcpTerminal && composedContains(this, target) ? target : null;
  }

  /** Files dropped from the OS on a running terminal tab: their paths are typed in, as a native terminal does. */
  #onFileDrop = (/** @type {Event} */ e) => {
    const { target, paths } = /** @type {CustomEvent<FileDrop>} */ (e).detail;
    const terminal = this.#ownTerminal(target);
    if (terminal && $terminals.get()[terminal.terminalId]?.status === 'running') terminal.paste(shellPaths(paths, app.platform));
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('acp-file-open', this.#onFileOpen);
    fileDrop.addEventListener('drop', this.#onFileDrop);
  }

  disconnectedCallback() {
    this.removeEventListener('acp-file-open', this.#onFileOpen);
    fileDrop.removeEventListener('drop', this.#onFileDrop);
    super.disconnectedCallback();
  }

  #onSessionApply = () => {
    const id = this.#sessionReview.view?.sessionId;
    if (id) sessionController.applyLocally(id);
  };

  #onSessionCheckOut = () => {
    const id = this.#sessionReview.view?.sessionId;
    if (id) sessionController.checkOutBranch(id);
  };

  /** The review a Changes view's events come from: an active worktree session tab's, else the project's. */
  get #reviewShown() {
    return this.#sessionReview.view ? this.#sessionReview : this.#review;
  }

  /**
   * Rendered unconditionally, so present after the first render.
   * @returns {import('../../components/tab-view/tab-view.js').AcpTabView}
   */
  get #tabView() {
    return /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (this.renderRoot.querySelector('acp-tab-view'));
  }

  /**
   * Opens a file in a tab, or switches to its tab.
   * @param {string} path Absolute.
   * @param {RevealAt | null} [at] Where to put the caret: a 1-based line, or a match to select.
   */
  openFile(path, at = null) {
    if (at !== null) this.#tabView.revealLine(path, at);
    openTab(path);
    projects.noteOpened(path);
  }

  /**
   * Opens the Changes tab with a file's diff expanded and scrolled into view.
   * @param {string} path Absolute.
   */
  async showChange(path) {
    openChangesTab();
    const rel = projects.relPath(path);
    if (rel === null) return;
    this.#review.expand(rel);
    await this.updateComplete;
    await this.#tabView.revealChange(path);
  }

  /**
   * Shows a file where its comment is: its diff in the Changes tab (the bar there lists only changed
   * files), else its tab.
   * @param {string} path Absolute.
   */
  #showFile(path) {
    if ($activePath.get() === CHANGES_TAB_ID) this.showChange(path);
    else this.openFile(path);
  }

  /** Opens the Settings tab, or switches to it. */
  openSettings() {
    openSettingsTab();
  }

  /** The active code tab's selected text, `''` when none. */
  selectedText() {
    return this.#tabView.selectedText();
  }

  /**
   * Moves the caret in the open file. No-op without one.
   * @param {number} line 1-based.
   */
  goToLine(line) {
    const path = $activePath.get();
    if (path !== null) this.#tabView.revealLine(path, line);
  }

  /** @param {Event} e */
  #onTabClose(e) {
    const { id, scope } = /** @type {CustomEvent<{ id: string, scope: CloseScope }>} */ (e).detail;
    if (scope === 'tab') closeTab(id);
    else if (scope === 'others') closeOtherTabs(id);
    else if (scope === 'right') closeTabsToRight(id);
    else closeAllTabs();
  }

  /** A save refused because the file changed on disk asks the tab view whether to overwrite it. */
  #onTabSave = async (/** @type {Event} */ e) => {
    const { id, force } = /** @type {CustomEvent<{ id: string, force?: boolean }>} */ (e).detail;
    if (!(await this.#files.save(id, { force }))) this.#tabView.confirmOverwrite(id);
  };

  /** @param {Event} e */
  #onCopyPath(e) {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    app.copy(path, 'Copying the path failed');
  }

  /** @param {Event} e */
  #onSettingsChange(e) {
    const { patch } = /** @type {CustomEvent<{ patch: Partial<Settings> }>} */ (e).detail;
    if (patch.appearance !== undefined) setAppearance(patch.appearance);
    if (patch.accent !== undefined) setAccent(patch.accent);
    if (patch.editorFont !== undefined) setEditorFont(patch.editorFont);
    if (patch.editorFontSize !== undefined) setEditorFontSize(patch.editorFontSize);
  }

  /** @param {Event} e An `acp-agent-add` or `acp-agent-update`. */
  async #onAgentSave(e) {
    const { agentId, agent } = /** @type {CustomEvent<{ agentId?: string, agent: NewAgent }>} */ (e).detail;
    // Retargeted to the tab view out here; the form (or the Agents tab's registry row) that asked is where the event began.
    const form = /** @type {{ saveFinished(error: string | null): void }} */ (/** @type {unknown} */ (e.composedPath()[0]));
    try {
      await (agentId ? agentConfig.update(agentId, agent) : agentConfig.add(agent));
      form.saveFinished(null);
    } catch (err) {
      form.saveFinished(err instanceof Error ? err.message : String(err));
    }
  }

  render() {
    const { active, pinned } = this.#editorTabs.value;
    const settings = this.#settings.value;
    return html`<acp-panel>
      <acp-tab-view
        class="acp-main-column__tabs"
        .tabs=${this.#files.tabs}
        .active=${active}
        .pinned=${pinned}
        .root=${this.#workspace.value?.path ?? null}
        .rootId=${this.#rootId.value}
        .listDir=${listDir}
        .terminals=${this.#terminals.value}
        .terminalConnect=${terminalController.connect}
        .terminalBusy=${terminalController.busy}
        .droppingTerminal=${this.#ownTerminal(this.#fileDropTarget.value)?.terminalId ?? null}
        .worktrees=${this.#worktrees.value}
        .sessionReview=${this.#sessionReview.view}
        .languages=${this.#fileLanguages.value}
        .editorFont=${settings.editorFont}
        .editorFontSize=${settings.editorFontSize}
        .comments=${this.#comments.value}
        .commentFocus=${this.#commentFocus.value}
        .settings=${settings}
        .fonts=${this.#systemFonts.value}
        .agents=${this.#agentList.value}
        .settingsReveal=${this.#settingsReveal.value}
        .agentsView=${this.#agentsView.value}
        .agentsQuery=${this.#agentsQuery.value}
        .agentsPending=${this.#agentsPending.value}
        .agentsSignIns=${signInsOf(this.#signIns.value, this.#workspace.value?.path ?? null)}
        .agentsTerminal=${Object.keys(this.#agentViews.value)}
        .agentsReveal=${this.#agentsReveal.value}
        .review=${{
          changes: this.#gitChanges.value,
          repo: this.#gitRepo.value,
          selection: this.#commitSelection.value,
          expanded: this.#review.expanded,
          diffs: this.#review.diffs,
        }}
        @acp-tab-activate=${(/** @type {CustomEvent<{ id: string }>} */ e) => activateTab(e.detail.id)}
        @acp-tab-close=${this.#onTabClose}
        @acp-tab-pin=${(/** @type {CustomEvent<{ id: string, pinned: boolean }>} */ e) =>
          setTabPinned(e.detail.id, e.detail.pinned)}
        @acp-tab-move=${(/** @type {CustomEvent<{ id: string, index: number }>} */ e) =>
          moveTab(e.detail.id, e.detail.index)}
        @acp-tab-edit=${(/** @type {CustomEvent<{ id: string, value: string }>} */ e) =>
          this.#files.edit(e.detail.id, e.detail.value)}
        @acp-tab-save=${this.#onTabSave}
        @acp-tab-reload=${(/** @type {CustomEvent<{ id: string }>} */ e) => this.#files.reload(e.detail.id)}
        @acp-copy-path=${this.#onCopyPath}
        @acp-terminal-copy=${(/** @type {CustomEvent<{ text: string }>} */ e) =>
          app.copy(e.detail.text, 'Copying failed')}
        @acp-terminal-restart=${(/** @type {CustomEvent<{ terminalId: string }>} */ e) =>
          terminalController.restart(e.detail.terminalId)}
        @acp-terminal-title=${(/** @type {CustomEvent<{ terminalId: string, title: string }>} */ e) =>
          setTerminalTitle(e.detail.terminalId, e.detail.title)}
        @acp-link-open=${(/** @type {CustomEvent<{ url: string }>} */ e) =>
          openUrl(e.detail.url).catch((err) => app.reportError('Opening link failed', err))}
        @acp-tab-language=${(/** @type {CustomEvent<{ path: string, language: string }>} */ e) =>
          setFileLanguage(e.detail.path, e.detail.language)}
        @acp-comment-add=${(/** @type {CustomEvent<{ path: string, draft: CommentDraft }>} */ e) =>
          addComment(e.detail.path, e.detail.draft, commentAuthor)}
        @acp-comment-edit=${(
          /** @type {CustomEvent<{ path: string, threadId: string, commentId: string, body: string }>} */ e,
        ) => editComment(e.detail.path, e.detail.threadId, e.detail.commentId, e.detail.body)}
        @acp-comment-delete=${(/** @type {CustomEvent<{ path: string, threadId: string, commentId: string }>} */ e) =>
          deleteComment(e.detail.path, e.detail.threadId, e.detail.commentId)}
        @acp-comment-revealed=${(/** @type {CustomEvent<{ focus: CommentFocus }>} */ e) => {
          if ($commentFocus.get() === e.detail.focus) focusComment(null);
        }}
        @acp-chat-add=${(/** @type {CustomEvent<{ inserts: ChatInsert[] }>} */ e) => addToChat(e.detail.inserts)}
        @acp-change-toggle=${(/** @type {CustomEvent<{ id: string }>} */ e) => this.#reviewShown.toggle(e.detail.id)}
        @acp-change-expand=${(/** @type {CustomEvent<{ id: string }>} */ e) => this.#reviewShown.expand(e.detail.id)}
        @acp-changes-collapse=${() => this.#reviewShown.collapseAll()}
        @acp-session-apply=${this.#onSessionApply}
        @acp-session-check-out=${this.#onSessionCheckOut}
        @acp-commit-pick=${(/** @type {CustomEvent<{ ids: string[], picked: boolean }>} */ e) =>
          pickForCommit(e.detail.ids, e.detail.picked)}
        @acp-commit-select=${(/** @type {CustomEvent<{ ids: string[] }>} */ e) => setCommitSelection(e.detail.ids)}
        @acp-settings-change=${this.#onSettingsChange}
        @acp-settings-reset=${(/** @type {CustomEvent<{ section: SettingsSection }>} */ e) =>
          resetSection(e.detail.section)}
        @acp-settings-revealed=${(/** @type {CustomEvent<{ reveal: SettingsReveal }>} */ e) =>
          settingsRevealed(e.detail.reveal)}
        @acp-agents-file-open=${() => agentConfig.openFile()}
        @acp-agents-import=${(/** @type {CustomEvent<{ agentIds?: string[] } | null>} */ e) =>
          agentConfig.importUserAgents(e.detail?.agentIds ?? null)}
        @acp-agents-query=${(/** @type {CustomEvent<AgentsQuery>} */ e) => agentConfig.search(e.detail)}
        @acp-agent-version-update=${(/** @type {CustomEvent<{ agentId: string }>} */ e) => agentConfig.updateVersion(e.detail.agentId)}
        @acp-agents-update-all=${() => agentConfig.updateAll()}
        @acp-agents-registry-check=${() => agentConfig.checkRegistry()}
        @acp-agents-revealed=${(/** @type {CustomEvent<{ reveal: AgentsReveal }>} */ e) => agentsRevealed(e.detail.reveal)}
        @acp-agent-add=${this.#onAgentSave}
        @acp-agent-update=${this.#onAgentSave}
        @acp-agent-enable=${(/** @type {CustomEvent<{ agentId: string, enabled: boolean }>} */ e) =>
          agentConfig.setEnabled(e.detail.agentId, e.detail.enabled)}
        @acp-agent-session-view=${(/** @type {CustomEvent<{ agentId: string, view: SessionView }>} */ e) =>
          setAgentView(e.detail.agentId, e.detail.view)}
        @acp-agent-default=${(/** @type {CustomEvent<{ agentId: string }>} */ e) => agentConfig.setDefault(e.detail.agentId)}
        @acp-agent-remove=${(/** @type {CustomEvent<{ agentId: string }>} */ e) => agentConfig.remove(e.detail.agentId)}
        @acp-agent-sign-in=${(/** @type {CustomEvent<{ agentId: string, methodId: string | null }>} */ e) =>
          agentConfig.signIn(e.detail.agentId, e.detail.methodId)}
      ></acp-tab-view>
      <acp-comment-bar
        placement=${this.#activePath.value === CHANGES_TAB_ID ? 'changes' : 'file'}
        .comments=${this.#tabComments.value}
        @acp-comment-focus=${(/** @type {CustomEvent<CommentFocus>} */ e) => focusComment(e.detail)}
        @acp-comments-send=${() => sendToChat($tabComments.get())}
      ></acp-comment-bar>
    </acp-panel>`;
  }
}

customElements.define('acp-main-column', AcpMainColumn);
