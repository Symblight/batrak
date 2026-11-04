import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { html, nothing } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/panel/panel.js';
import { codeEditor } from '../../components/code-view/code-editor.js';
import { markdownView } from '../../hooks/markdown-view/markdown-view.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { contentKindOf } from '../../controllers/tab-content/TabContentController.js';
import { TabFilesController } from '../../controllers/tab-files/TabFilesController.js';
import {
  $activePath,
  $editorTabs,
  CHANGES_TAB_ID,
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  moveTab,
  openChanges as openChangesTab,
  openSettings as openSettingsTab,
  openTab,
  setTabPinned,
} from '../../stores/editor/editor.js';
import { addToChat } from '../../stores/chat/chat.js';
import {
  $commentFocus,
  $tabComments,
  addComment,
  deleteComment,
  editComment,
  focusComment,
  sendToChat,
} from '../../stores/comments/comments.js';
import { $terminals, moveTerminalToEditor } from '../../stores/terminals/terminals.js';
import { $project } from '../../stores/project/project.js';
import { $workspaces } from '../../stores/workspaces/workspaces.js';
import '../../components/tab-view/tab-view.js';
import '../agents-tab/agents-tab.js';
import '../changes-tab/changes-tab.js';
import '../editor-view/editor-view.js';
import '../workspace-changes-tab/workspace-changes-tab.js';
import '../settings-view/settings-view.js';
import '../terminal-view/terminal-view.js';
import '../../components/comment-bar/comment-bar.js';

/** @typedef {import('../../hooks/search/types.js').RevealAt} RevealAt */
/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/chat/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../hooks/comments/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../components/tab-strip/tab-strip.js').CloseScope} CloseScope */
/** @typedef {Parameters<typeof addComment>[1]} CommentDraft */

/**
 * @tag acp-main-column
 * @summary The main column: everything opens in its tabs (files, Changes, Settings, terminals).
 */
export class AcpMainColumn extends ViewElement {
  #files = new TabFilesController(this);
  #editorTabs = new StoreController(this, { store: $editorTabs });
  #project = new StoreController(this, { store: $project });
  #workspaces = new StoreController(this, { store: $workspaces });
  #tabComments = new StoreController(this, { store: $tabComments });
  #terminals = new StoreController(this, { store: $terminals });

  /** A comment to reveal: show its file; the editor that shows it then reveals it. */
  #commentFocus = new StoreController(this, {
    store: $commentFocus,
    onChange: (focus) => {
      if (focus) this.#showFile(focus.path);
    },
  });

  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-changes-tab']>} The project's Changes tab, once open. */
  #changesTab = createRef();

  /** The bar sits lower in the Changes tab, which has no footer. */
  #activePath = new StoreController(this, { store: $activePath });

  #onFileOpen = (/** @type {Event} */ e) => {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number }>} */ (e).detail;
    this.openFile(path, line);
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('acp-file-open', this.#onFileOpen);
  }

  disconnectedCallback() {
    this.#disarmChord();
    this.removeEventListener('acp-file-open', this.#onFileOpen);
    super.disconnectedCallback();
  }

  /** The active tab's path when it is a markdown file. */
  get #activeMarkdownPath() {
    const active = $activePath.get();
    const tab = this.#files.tabs.find((t) => t.id === active);
    return tab && contentKindOf(tab) === 'markdown' ? tab.path : null;
  }

  /** Waiting for the second key of Mod+K. */
  #chordTimer = 0;

  #disarmChord() {
    clearTimeout(this.#chordTimer);
    this.#chordTimer = 0;
  }

  /**
   * The markdown view's keys, while the active tab is a markdown file: `markdownSplit` (Mod+K then V; the
   * chord waits 1.2 s) toggles Split, `markdownPreview` Preview, Esc (from the file's panel) leaves Preview unless text is selected. In the
   * capture phase, so the editor's own keymap doesn't see them first.
   * @param {KeyboardEvent} e
   */
  #onKeydown = (e) => {
    const path = this.#activeMarkdownPath;
    if (path === null) {
      this.#disarmChord();
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (this.#chordTimer) {
      this.#disarmChord();
      if (shortcuts.matchesThen('markdownSplit', e)) {
        claim();
        markdownView.toggle(path, 'split');
        return;
      }
    }
    if (shortcuts.matches('markdownSplit', e)) {
      claim();
      this.#chordTimer = window.setTimeout(() => this.#disarmChord(), 1200);
    } else if (shortcuts.matches('markdownPreview', e)) {
      claim();
      markdownView.toggle(path, 'preview');
    } else if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && markdownView.modeOf(path) === 'preview') {
      // Only in the file's own panel: a dialog of the tab view answers its Esc itself.
      const inPanel = e.composedPath().some((n) => n instanceof Element && n.localName === 'md-tab-panel' && n.hasAttribute('active'));
      if (!inPanel || getSelection()?.toString()) return;
      claim();
      markdownView.setMode(path, 'raw');
    }
  };

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
    await this.updateComplete;
    await this.#tabView.updateComplete;
    await this.#changesTab.value?.reveal(rel);
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

  /**
   * The content of the tabs whose view this column owns: files as text get their editor.
   * @param {EditorTab} tab
   */
  #renderTabContent = (tab) => {
    switch (contentKindOf(tab)) {
      case 'code':
      case 'markdown':
        return html`<acp-editor-view .tab=${tab}></acp-editor-view>`;
      case 'settings':
        return html`<acp-settings-view></acp-settings-view>`;
      case 'agents':
        return html`<acp-agents-tab></acp-agents-tab>`;
      case 'terminal':
        return html`<acp-terminal-view terminal-id=${tabs.terminalOf(tab.id) ?? ''}></acp-terminal-view>`;
      case 'changes':
        return html`<acp-changes-tab ${ref(this.#changesTab)}></acp-changes-tab>`;
      case 'workspace-changes':
        return html`<acp-workspace-changes-tab .workspaceId=${tabs.workspaceOf(tab.id)}></acp-workspace-changes-tab>`;
      default:
        return nothing;
    }
  };

  /** @type {import('lit/directives/ref.js').Ref<HTMLElementTagNameMap['acp-confirm-dialog']>} A ref: a tab's view can hold a dialog of its own. */
  #confirmDialogRef = createRef();
  #confirmDialog = () => /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.#confirmDialogRef.value);

  render() {
    const { active, pinned } = this.#editorTabs.value;
    return html`<acp-panel>
      <acp-tab-view
        class="acp-main-column__tabs"
        .tabs=${this.#files.tabs}
        .active=${active}
        .pinned=${pinned}
        .root=${this.#project.value?.path ?? null}
        .terminals=${this.#terminals.value}
        .terminalBusy=${terminals.busy}
        .confirmDialog=${this.#confirmDialog}
        .workspaces=${this.#workspaces.value}
        .renderContent=${this.#renderTabContent}
        @keydown=${{ handleEvent: this.#onKeydown, capture: true }}
        .dropName=${tabs.editorDrop}
        .acceptsDrop=${tabs.isTerminal}
        @acp-tab-receive=${(/** @type {CustomEvent<{ id: string, index: number }>} */ e) =>
          moveTerminalToEditor(tabs.terminalOf(e.detail.id) ?? '', e.detail.index)}
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
        @acp-link-open=${(/** @type {CustomEvent<{ url: string }>} */ e) =>
          app.openUrl(e.detail.url).catch((err) => app.reportError('Opening link failed', err))}
        @acp-comment-add=${(/** @type {CustomEvent<{ path: string, draft: CommentDraft }>} */ e) =>
          addComment(e.detail.path, e.detail.draft, codeEditor.author)}
        @acp-comment-edit=${(
          /** @type {CustomEvent<{ path: string, threadId: string, commentId: string, body: string }>} */ e,
        ) => editComment(e.detail.path, e.detail.threadId, e.detail.commentId, e.detail.body)}
        @acp-comment-delete=${(/** @type {CustomEvent<{ path: string, threadId: string, commentId: string }>} */ e) =>
          deleteComment(e.detail.path, e.detail.threadId, e.detail.commentId)}
        @acp-comment-revealed=${(/** @type {CustomEvent<{ focus: CommentFocus }>} */ e) => {
          if ($commentFocus.get() === e.detail.focus) focusComment(null);
        }}
        @acp-chat-add=${(/** @type {CustomEvent<{ inserts: ChatInsert[] }>} */ e) => addToChat(e.detail.inserts)}
      ></acp-tab-view>
      <acp-comment-bar
        placement=${this.#activePath.value === CHANGES_TAB_ID ? 'changes' : 'file'}
        .comments=${this.#tabComments.value}
        @acp-comment-focus=${(/** @type {CustomEvent<CommentFocus>} */ e) => focusComment(e.detail)}
        @acp-comments-send=${() => sendToChat($tabComments.get())}
      ></acp-comment-bar>
    </acp-panel>
      <acp-confirm-dialog ${ref(this.#confirmDialogRef)}></acp-confirm-dialog>`;
  }
}

customElements.define('acp-main-column', AcpMainColumn);
