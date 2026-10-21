import { LitElement, html } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { commentAuthor } from '../../models/editor-plugins.js';
import { agentConfig } from '../../services/agent-config.js';
import { copyText } from '../../services/clipboard.js';
import { listDir } from '../../services/ipc.js';
import { loadSystemFonts } from '../../services/fonts.js';
import { projectController } from '../../services/project-controller.js';
import { sessionController } from '../../services/session-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { TabFilesController } from '../../controllers/tab-files/TabFilesController.js';
import { ChangesReviewController } from '../../controllers/changes-review/ChangesReviewController.js';
import { SessionChangesController } from '../../controllers/session-changes/SessionChangesController.js';
import {
  $activePath,
  $editorTabs,
  $fileLanguages,
  $settingsReveal,
  CHANGES_TAB_ID,
  SETTINGS_TAB_ID,
  activateTab,
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
} from '../../stores/editor.js';
import { $agentList } from '../../stores/agents.js';
import { addToChat } from '../../stores/chat.js';
import {
  $commentFocus,
  $comments,
  $tabComments,
  addComment,
  deleteComment,
  editComment,
  focusComment,
  sendToChat,
} from '../../stores/comments.js';
import { $systemFonts } from '../../stores/fonts.js';
import { $commitSelection, $gitChanges, $gitRepo, pickForCommit, setCommitSelection } from '../../stores/git.js';
import {
  $settings,
  resetSection,
  setAccent,
  setAppearance,
  setEditorFont,
  setEditorFontSize,
} from '../../stores/settings.js';
import { $worktrees } from '../../stores/sessions.js';
import { $rootId, $workspace, $workspaceSettings } from '../../stores/workspace.js';
import '../acp-tab-view/acp-tab-view.js';
import '../acp-comment-bar/acp-comment-bar.js';
import styles from './acp-main-column.css?inline';

/** @typedef {import('../../models/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types.js').NewAgent} NewAgent */
/** @typedef {import('../../models/types.js').LocalTurns} LocalTurns */
/** @typedef {import('../../models/types.js').SettingsReveal} SettingsReveal */
/** @typedef {import('../../models/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../models/types.js').Settings} Settings */
/** @typedef {import('../../models/settings.js').SettingsSection} SettingsSection */
/** @typedef {import('../acp-tab-view/acp-tab-view.js').CloseScope} CloseScope */
/** @typedef {Parameters<typeof addComment>[1]} CommentDraft */

/**
 * @tag acp-main-column
 * @summary The main column: everything opens in its tabs (files, Changes, Settings).
 */
export class AcpMainColumn extends LitElement {
  static styles = styles;

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
  #workspaceSettings = new StoreController(this, { store: $workspaceSettings });
  #settingsReveal = new StoreController(this, { store: $settingsReveal });
  #comments = new StoreController(this, { store: $comments });
  #tabComments = new StoreController(this, { store: $tabComments });
  #gitChanges = new StoreController(this, { store: $gitChanges });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #commitSelection = new StoreController(this, { store: $commitSelection });

  /** A comment to reveal: show its file; the editor that shows it then reveals it. */
  #commentFocus = new StoreController(this, {
    store: $commentFocus,
    onChange: (focus) => {
      if (focus) this.#showFile(focus.path);
    },
  });

  /**
   * The bar sits lower in the Changes tab, which has no footer. Settings lists the fonts, and the
   * agents with the versions they reported since.
   */
  #activePath = new StoreController(this, {
    store: $activePath,
    onChange: (path) => {
      if (path !== SETTINGS_TAB_ID) return;
      loadSystemFonts();
      agentConfig.refresh();
    },
  });

  #onFileOpen = (/** @type {Event} */ e) => {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.openFile(path, line);
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('acp-file-open', this.#onFileOpen);
  }

  disconnectedCallback() {
    this.removeEventListener('acp-file-open', this.#onFileOpen);
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
   * @returns {import('../acp-tab-view/acp-tab-view.js').AcpTabView}
   */
  get #tabView() {
    return /** @type {HTMLElementTagNameMap['acp-tab-view']} */ (this.renderRoot.querySelector('acp-tab-view'));
  }

  /**
   * Opens a file in a tab, or switches to its tab.
   * @param {string} path Absolute.
   * @param {number | null} [line] 1-based line to put the caret on.
   */
  openFile(path, line = null) {
    if (line !== null) this.#tabView.revealLine(path, line);
    openTab(path);
    projectController.noteOpened(path);
  }

  /**
   * Opens the Changes tab with a file's diff expanded and scrolled into view.
   * @param {string} path Absolute.
   */
  async showChange(path) {
    openChangesTab();
    const rel = projectController.relPath(path);
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

  /** @param {Event} e */
  #onCopyPath(e) {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    copyText(path, 'Copying the path failed');
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
    // Retargeted to the tab view out here; the form that asked is where the event began.
    const form = /** @type {HTMLElementTagNameMap['acp-settings-agents']} */ (e.composedPath()[0]);
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
    return html`<acp-tab-view
        class="acp-main-column__tabs"
        .tabs=${this.#files.tabs}
        .active=${active}
        .pinned=${pinned}
        .root=${this.#workspace.value?.path ?? null}
        .rootId=${this.#rootId.value}
        .listDir=${listDir}
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
        .localTurns=${this.#workspace.value ? this.#workspaceSettings.value.localTurns : null}
        .settingsReveal=${this.#settingsReveal.value}
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
        @acp-tab-save=${(/** @type {CustomEvent<{ id: string }>} */ e) => this.#files.save(e.detail.id)}
        @acp-copy-path=${this.#onCopyPath}
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
        @acp-agents-import=${() => agentConfig.importUserAgents()}
        @acp-local-turns-change=${(/** @type {CustomEvent<{ localTurns: LocalTurns }>} */ e) => {
          const workspace = $workspace.get();
          if (workspace) sessionController.setLocalTurns(workspace.path, e.detail.localTurns);
        }}
        @acp-agent-add=${this.#onAgentSave}
        @acp-agent-update=${this.#onAgentSave}
        @acp-agent-default=${(/** @type {CustomEvent<{ agentId: string }>} */ e) => agentConfig.setDefault(e.detail.agentId)}
        @acp-agent-remove=${(/** @type {CustomEvent<{ agentId: string }>} */ e) => agentConfig.remove(e.detail.agentId)}
      ></acp-tab-view>
      <acp-comment-bar
        class=${classMap({
          'acp-main-column__comment-bar': true,
          'acp-main-column__comment-bar_changes': this.#activePath.value === CHANGES_TAB_ID,
        })}
        .comments=${this.#tabComments.value}
        @acp-comment-focus=${(/** @type {CustomEvent<CommentFocus>} */ e) => focusComment(e.detail)}
        @acp-comments-send=${() => sendToChat($tabComments.get())}
      ></acp-comment-bar>`;
  }
}

customElements.define('acp-main-column', AcpMainColumn);
