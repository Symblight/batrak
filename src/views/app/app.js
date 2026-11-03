import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import { agents } from '../../hooks/agents/agents.js';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { html, nothing } from 'lit';
import { sessions } from '../../hooks/sessions/sessions.js';
import { git } from '../../hooks/git/git.js';
import { github } from '../../hooks/github/github.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { search } from '../../hooks/search/search.js';
import { $about } from '../../stores/about/about.js';
import { $activePath } from '../../stores/editor/editor.js';
import { $githubAccount, $pullRequestHere } from '../../stores/github/github.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $columnWidths, $hiddenColumns, showColumn, toggleColumn } from '../../stores/layout/layout.js';
import { $notices, dismissNotice, holdNotices, runNoticeAction } from '../../stores/notices/notices.js';
import { $terminalPanel, $terminalPanelHeight, $terminalTabs, TERMINAL_PANEL_MAX_HEIGHT, TERMINAL_PANEL_MIN_HEIGHT, clearTerminalPanelHeight, setTerminalPanelHeight } from '../../stores/terminals/terminals.js';
import { $sessions, $worktrees } from '../../stores/sessions/sessions.js';
import { $trustPrompt } from '../../stores/trust/trust.js';
import { $unreadSessions, markWorkspaceRead } from '../../stores/session-read/session-read.js';
import { $projects, toggleProject } from '../../stores/projects/projects.js';
import { $project } from '../../stores/project/project.js';
import { $activeWorkspaceId, $rootId, $workspaces, MAIN } from '../../stores/workspaces/workspaces.js';
import { $pickerWorkspaces, $workspaceNumbers, $workspaceStatuses } from '../../stores/workspace-status/workspace-status.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/about-dialog/about-dialog.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/toolbar/toolbar.js';
import '../../components/workspace-dialog/workspace-dialog.js';
import '../../components/workspace-delete-dialog/workspace-delete-dialog.js';
import '../session-column/session-column.js';
import '../agent-column/agent-column.js';
import '../main-column/main-column.js';
import '../file-column/file-column.js';
import '../terminals-view/terminals-view.js';
import '../../components/nav-rail/nav-rail.js';
import '../../components/quick-open/quick-open.js';
import '../search-view/search-view.js';
import '../../components/snackbars/snackbars.js';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/column-split/column-split.js';

/** @typedef {import('../file-column/file-column.js').SideView} SideView */
/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../hooks/agents/types.js').TrustPrompt} TrustPrompt */
/** @typedef {import('../../hooks/search/types.js').SearchDialogState} SearchDialogState */

/*
 * The window is a row of the session column, the center and the file column; the center is a
 * column of the middle (a row of the agent and main columns) over the terminal panel. Session and
 * file columns shrink, down to their resize minimums, to fit the center's minimum; in the middle the
 * agent column shrinks first (its far larger shrink factor), down to its own minimum. A drag starts
 * from the rendered width. Every split reads and writes the one `$columnWidths`.
 */
/** @type {readonly import('../../components/column-split/column-split.js').SplitColumn[]} */
const COLUMNS = [
  {
    name: 'session',
    size: '--acp-session-column-width',
    minSize: '--acp-session-column-min-width',
    maxSize: '--acp-column-max-width',
    collapse: 'end',
    resize: { min: 180, max: 524, label: 'Resize sessions column' },
  },
  { name: 'center', minSize: '--acp-center-min-width' },
  {
    name: 'side',
    size: '--acp-file-tree-width',
    minSize: '--acp-file-tree-min-width',
    maxSize: '--acp-column-max-width',
    collapse: 'start',
    resize: { min: 200, max: 524, label: 'Resize file column', edge: 'start' },
  },
];

/** @type {readonly import('../../components/column-split/column-split.js').SplitColumn[]} The same, while no file is open: the center is the agent column alone. */
const COLUMNS_AGENT_ONLY = COLUMNS.map((column) => (column.name === 'center' ? { ...column, minSize: '--acp-agent-column-min-width' } : column));

/** @type {readonly import('../../components/column-split/column-split.js').SplitColumn[]} The same, while the agent column is hidden: the center is the editor alone. */
const COLUMNS_MAIN_ONLY = COLUMNS.map((column) => (column.name === 'center' ? { ...column, minSize: '--acp-main-column-min-width' } : column));

/** @type {readonly import('../../components/column-split/column-split.js').SplitColumn[]} */
const MIDDLE_COLUMNS = [
  {
    name: 'agent',
    size: '--acp-agent-column-width',
    minSize: '--acp-agent-column-min-width',
    shrink: 1000,
    resize: { min: 280, max: 1600, label: 'Resize agent column' },
  },
  { name: 'main', minSize: '--acp-main-column-min-width' },
];

/** @type {readonly import('../../components/column-split/column-split.js').SplitColumn[]} */
const CENTER_COLUMNS = [
  { name: 'middle', minSize: '--acp-middle-min-height' },
  {
    name: 'terminals',
    size: '--acp-terminal-panel-height',
    resize: { min: TERMINAL_PANEL_MIN_HEIGHT, max: TERMINAL_PANEL_MAX_HEIGHT, label: 'Resize terminal panel', edge: 'start' },
  },
];

/** @type {readonly string[]} The same array each render, so the row sees no change. */
const NO_COLUMNS = Object.freeze([]);
/** @type {readonly string[]} */
const AGENT_FILLS = Object.freeze(['agent']);
/** @type {readonly string[]} */
const NO_MAIN = Object.freeze(['main']);
/** @type {readonly string[]} */
const NO_AGENT = Object.freeze(['agent']);
/** @type {readonly string[]} */
const NO_PANEL = Object.freeze(['terminals']);

/**
 * @tag acp-app
 * @summary Root layout: toolbar, session/agent/editor/file columns, Quick Open, the search dialog, About, the project trust dialog, snackbars, global shortcuts and menu bar items.
 */
export class AcpApp extends ViewElement {
  static properties = {
    sideView: { state: true },
    quickOpenFiles: { state: true },
    home: { state: true },
    branches: { state: true },
    mainBranch: { state: true },
  };

  #columnWidths = new StoreController(this, { store: $columnWidths });
  #activePath = new StoreController(this, { store: $activePath });
  #hiddenColumns = new StoreController(this, { store: $hiddenColumns });
  #project = new StoreController(this, { store: $project });
  #projects = new StoreController(this, { store: $projects });
  #unread = new StoreController(this, { store: $unreadSessions });
  #terminalPanel = new StoreController(this, { store: $terminalPanel });
  #terminalTabs = new StoreController(this, { store: $terminalTabs });
  #panelHeight = new StoreController(this, { store: $terminalPanelHeight });
  #rootId = new StoreController(this, { store: $rootId });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #githubAccount = new StoreController(this, { store: $githubAccount });
  #sessions = new StoreController(this, { store: $sessions });
  #workspaces = new StoreController(this, { store: $workspaces });
  #workspaceId = new StoreController(this, { store: $activeWorkspaceId });
  #pickerWorkspaces = new StoreController(this, { store: $pickerWorkspaces });
  #workspaceStatuses = new StoreController(this, { store: $workspaceStatuses });
  #workspaceNumbers = new StoreController(this, { store: $workspaceNumbers });
  #pullRequest = new StoreController(this, { store: $pullRequestHere });
  #notices = new StoreController(this, { store: $notices });
  #about = new StoreController(this, { store: $about });
  #trustPrompt = new StoreController(this, { store: $trustPrompt, onChange: (prompt) => this.#askTrust(prompt) });
  /** Sequence of Quick Open queries; only the latest answer is shown. */
  #quickOpenRequest = 0;
  /** @type {Promise<() => void> | null} */
  #menuListener = null;

  #onMenuAction = (/** @type {import('../../hooks/app/app.js').MenuAction} */ id) => {
    if (id === 'about') this.#showAbout();
    else if (id === 'new-terminal') this.#newTerminal();
    else this.#showSettings();
  };

  #newTerminal() {
    terminals.newTerminal().catch((err) => app.reportError('Opening a terminal failed', err));
  }

  #openProjectTerminal() {
    terminals.showPanel().catch((err) => app.reportError('Opening a terminal failed', err));
  }

  /** @param {Event} e */
  #onWorkspaceEvent = (e) => {
    const detail = /** @type {CustomEvent<{ id: string, name: string, keepBranch: boolean, path: string }>} */ (e).detail;
    switch (e.type) {
      case 'acp-workspace-select':
        workspaces.select(detail.id);
        break;
      case 'acp-workspace-new':
        void this.renderRoot.querySelector('acp-workspace-dialog')?.show();
        break;
      case 'acp-workspace-rename':
        void workspaces.rename(detail.id, detail.name);
        break;
      case 'acp-workspace-delete-request':
        void workspaces.confirmDelete(detail.id, this.renderRoot.querySelector('acp-workspace-delete-dialog'));
        break;
      case 'acp-workspace-changes':
        workspaces.changes(detail.id);
        break;
      case 'acp-workspace-apply':
        void workspaces.apply(detail.id);
        break;
      case 'acp-workspace-check-out':
        void workspaces.checkOut(detail.id);
        break;
      case 'acp-open-terminal':
        terminals.openAt(detail.path);
        break;
    }
  };

  /** @param {Event} e */
  #onWorkspaceCreate = (e) => {
    workspaces.create(/** @type {CustomEvent<import('../../hooks/workspaces/types.js').CreateRequest>} */ (e).detail);
  };

  /** @param {Event} e */
  #onWorkspaceDelete = (e) => {
    const { id, keepBranch } = /** @type {CustomEvent<{ id: string, keepBranch: boolean }>} */ (e).detail;
    void workspaces.delete(id, keepBranch);
  };

  // A new workspace is based on Main's branches, whichever workspace is shown.
  // Before Create workspace's branch menu opens: fetch Main's repository, then list again.
  #fetchBranches = async () => {
    const rootId = this.#project.value?.rootId ?? null;
    if (rootId === null) return;
    try {
      await git.fetch(rootId);
    } catch (err) {
      app.reportError('Fetching branches failed', err);
    }
    await this.#onBranchesQuery();
  };

  #onBranchesQuery = async () => {
    const rootId = this.#project.value?.rootId ?? null;
    if (rootId === null) return;
    // Never another project's: what was listed goes, and an answer for a project no longer shown is dropped.
    this.branches = { local: [], remotes: [], default: null };
    this.mainBranch = null;
    try {
      const [branches, mainBranch] = await Promise.all([git.branches(rootId), git.branchOf(rootId)]);
      if (this.#project.value?.rootId !== rootId) return;
      this.branches = branches;
      this.mainBranch = mainBranch;
    } catch (err) {
      app.reportError('Listing branches failed', err);
    }
  };

  /**
   * `searchInFiles`: the search dialog. `quickOpen`. `toggleSessionView`: the session in chat /
   * terminal. `openFolder`: add a project, unless a dialog has the key. `markProjectRead`: the active
   * project's sessions, unless a dialog or a text field has the key. `newTerminal`. `settings` (Windows
   * and Linux; the menu's on macOS). While the search dialog is open, only `searchInFiles`.
   */
  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    const is = (/** @type {import('../../hooks/shortcuts/shortcuts.js').ShortcutId} */ id) => shortcuts.matches(id, e);
    if (is('searchInFiles')) {
      e.preventDefault();
      this.#showSearchDialog();
      return;
    }
    if (this.#searchView?.open) return;
    if (is('newTerminal')) {
      e.preventDefault();
      this.#newTerminal();
    } else if (is('quickOpen')) {
      e.preventDefault();
      this.#showQuickOpen();
    } else if (is('openFolder') && !AcpApp.#inDialog(e)) {
      e.preventDefault();
      this.#onProjectOpenFolder();
    } else if (is('toggleSessionView')) {
      e.preventDefault();
      this.renderRoot.querySelector('acp-agent-column')?.toggleView();
    } else if (is('markProjectRead') && !AcpApp.#takesKeys(e)) {
      e.preventDefault();
      const projectId = this.#project.value?.path;
      if (projectId) markWorkspaceRead(projectId, $activeWorkspaceId.get());
    } else if (is('settings')) {
      e.preventDefault();
      this.#showSettings();
    } else if (!AcpApp.#inDialog(e)) {
      this.#onWorkspaceKey(e);
    }
  };

  /**
   * `openWorkspaces`: the picker. `workspace1`…`9`: that workspace. `nextWaitingWorkspace`.
   * `newWorkspace`: its dialog, when the project can have workspaces. `newChat`: in the shown workspace.
   * @param {KeyboardEvent} e
   */
  #onWorkspaceKey(e) {
    const is = (/** @type {import('../../hooks/shortcuts/shortcuts.js').ShortcutId} */ id) => shortcuts.matches(id, e);
    const project = this.#project.value?.path ?? null;
    const number = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => is(/** @type {`workspace${1}`} */ (`workspace${n}`)));
    if (project === null) return;
    if (number !== undefined) workspaces.selectNumber(number);
    else if (is('openWorkspaces')) this.renderRoot.querySelector('acp-toolbar')?.showWorkspaces();
    else if (is('nextWaitingWorkspace')) workspaces.showNextWaiting();
    else if (is('newWorkspace') && this.#workspacesEnabled) void this.renderRoot.querySelector('acp-workspace-dialog')?.show();
    else if (is('newChat')) sessions.create(project, $activeWorkspaceId.get());
    else return;
    e.preventDefault();
  }

  /** The project can have workspaces: it has some, or it's a git repository with a commit. */
  get #workspacesEnabled() {
    return this.#pickerWorkspaces.value.length > 0 || Boolean(this.#gitRepo.value.repo?.sha);
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {boolean} The key was pressed in a dialog or a text field, which keep it.
   */
  static #takesKeys(e) {
    const origin = e.composedPath()[0];
    const editable =
      origin instanceof HTMLInputElement ||
      origin instanceof HTMLTextAreaElement ||
      origin instanceof HTMLSelectElement ||
      (origin instanceof HTMLElement && origin.isContentEditable);
    return editable || AcpApp.#inDialog(e);
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {boolean} The key was pressed inside a dialog.
   */
  static #inDialog(e) {
    return e.composedPath().some((n) => n instanceof HTMLElement && (n.localName === 'dialog' || n.localName === 'md-dialog'));
  }

  constructor() {
    super();
    /** @type {SideView} Mirrors the file column's view, for the rail's pressed button. */
    this.sideView = 'files';
    /** @type {QuickOpenItem[]} */
    this.quickOpenFiles = [];
    /** @type {string | null} Shown as `~` in the project menu's paths. */
    this.home = null;
    /** @type {import('../../hooks/git/types.js').BranchList} The project's branches, for Create workspace's From. */
    this.branches = { local: [], remotes: [], default: null };
    /** @type {string | null} Main's checked-out branch, for Create workspace's From. */
    this.mainBranch = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // First: the previous page load's shells must be closed before anything opens one.
    terminals.start();
    window.addEventListener('keydown', this.#onKeydown);
    this.#menuListener = app.onMenuAction(this.#onMenuAction);
    this.#menuListener.catch((err) => app.log('warn', `menu bar not connected: ${err}`));
    agents.start();
    workspaces.start();
    sessions.init().catch((err) => app.reportError('Loading sessions failed', err));
    git.start();
    github.start();
    projects.restore().catch((err) => app.reportError('Reopening folder failed', err));
    projects
      .homeDir()
      .then((home) => (this.home = home.replace(/[\\/]+$/, '')))
      .catch(() => {});
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.#onKeydown);
    this.#menuListener?.then((stop) => stop()).catch(() => {});
    this.#menuListener = null;
    super.disconnectedCallback();
  }

  /**
   * Shows the trust dialog for `prompt`, or closes it; an answer counts only while its prompt is current.
   * @param {TrustPrompt | null} prompt
   */
  async #askTrust(prompt) {
    await this.updateComplete;
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('.acp-app__trust')
    );
    if (prompt === null) {
      dialog.close();
      return;
    }
    const trusted = await dialog.confirm(agents.trustConfirm(prompt));
    if ($trustPrompt.get() !== prompt) return;
    if (!trusted) agents.dismissTrust();
    else for (const id of await agents.trust()) sessions.restart(id);
  }

  /** Rendered unconditionally, so present after the first render. */
  get #main() {
    return /** @type {HTMLElementTagNameMap['acp-main-column']} */ (
      this.renderRoot.querySelector('acp-main-column')
    );
  }

  /** Rendered unconditionally, so present after the first render. */
  get #files() {
    return /** @type {HTMLElementTagNameMap['acp-file-column']} */ (
      this.renderRoot.querySelector('acp-file-column')
    );
  }

  #showFiles() {
    this.sideView = 'files';
    showColumn('side');
    this.#files.showFiles();
  }

  #showSearch() {
    this.sideView = 'search';
    showColumn('side');
    this.#files.showSearch();
  }

  #showChanges() {
    this.sideView = 'changes';
    showColumn('side');
    this.#files.showChanges();
  }

  #showSettings() {
    this.#main.openSettings();
  }

  #showAbout() {
    app.loadAbout();
    /** @type {HTMLElementTagNameMap['acp-about-dialog']} */ (this.renderRoot.querySelector('acp-about-dialog')).show();
  }

  /** Opens Quick Open; `:` (Go to line) needs a file open in the editor. */
  #showQuickOpen() {
    const palette = /** @type {HTMLElementTagNameMap['acp-quick-open']} */ (
      this.renderRoot.querySelector('acp-quick-open')
    );
    palette.hasOpenFile = $activePath.get() !== null;
    palette.show();
  }

  /** @param {Event} e */
  async #onPaletteQuery(e) {
    const { query } = /** @type {CustomEvent<{ query: string | null }>} */ (e).detail;
    const id = ++this.#quickOpenRequest;
    const rootId = this.#rootId.value;
    if (query === null || rootId === null) {
      this.quickOpenFiles = [];
      return;
    }
    try {
      const result = await search.quickOpen(rootId, query);
      if (id !== this.#quickOpenRequest || result.cancelled) return;
      this.quickOpenFiles = result.items;
    } catch (err) {
      app.reportError('File search failed', err);
    }
  }

  /** @param {Event} e */
  #onPalettePick(e) {
    this.#main.openFile(projects.absPath(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path));
  }

  /** @returns {HTMLElementTagNameMap['acp-search-view'] | null} */
  get #searchView() {
    return this.renderRoot.querySelector('acp-search-view');
  }

  /** Opens the search dialog with the project's last search, or the editor's selection; open, selects the query. */
  #showSearchDialog() {
    this.#searchView?.show(this.#main.selectedText());
  }

  /**
   * A match from the dialog: its tab, with the match selected.
   * @param {Event} e
   */
  #onSearchOpen(e) {
    const { path, line, column, length } = /** @type {CustomEvent<{ path: string, line: number, column: number, length: number }>} */ (e).detail;
    this.#main.openFile(path, { line, column, length });
  }

  /**
   * "Open in panel": the side column's Search pane takes the dialog's search.
   * @param {Event} e
   */
  #onSearchPopout(e) {
    const { state } = /** @type {CustomEvent<{ state: SearchDialogState }>} */ (e).detail;
    this.sideView = 'search';
    showColumn('side');
    this.#files.showSearch(state);
  }

  /** @param {Event} e */
  #onProjectSelect(e) {
    const id = /** @type {CustomEvent<{ projectId: string }>} */ (e).detail.projectId;
    toggleProject(id, true);
    projects.activate(id).catch((err) => app.reportError('Opening project failed', err));
  }

  #onProjectOpenFolder() {
    projects.open().catch((err) => app.reportError('Opening folder failed', err));
  }

  /** @param {Event} e */
  #onProjectReveal(e) {
    projects
      .reveal(/** @type {CustomEvent<{ projectId: string }>} */ (e).detail.projectId)
      .catch((err) => app.reportError('Revealing folder failed', err));
  }

  /** @param {Event} e */
  #onProjectRemove(e) {
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.renderRoot.querySelector('.acp-app__confirm'));
    projects.confirmRemove(/** @type {CustomEvent<{ projectId: string }>} */ (e).detail.projectId, dialog);
  }

  /** @param {Event} e */
  #onBranchCopy = (e) => app.copy(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text, 'Copying the branch name failed');

  /** @param {Event} e */
  #onGithubOpen = (e) => {
    app.openUrl(/** @type {CustomEvent<{ url: string }>} */ (e).detail.url).catch((err) => app.reportError('Opening the page failed', err));
  };

  /** @param {Event} e */
  #onColumnToggle(e) {
    toggleColumn(/** @type {CustomEvent<{ column: string }>} */ (e).detail.column);
  }

  /** @param {Event} e */
  #onRevealPath(e) {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    projects.reveal(path).catch((err) => app.log('warn', `showing logs failed: ${err}`));
  }

  /** @param {Event} e */
  #onFileOpen(e) {
    const { path, line, column, length } = /** @type {CustomEvent<{ path: string, line?: number, column?: number, length?: number }>} */ (
      e
    ).detail;
    // A search match comes with its range, selected in the tab.
    const at = line !== undefined && column !== undefined && length !== undefined ? { line, column, length } : line;
    this.#main.openFile(path, at);
  }

  /**
   * A file named in the chat: its tab, and its row in the file tree.
   * @param {Event} e
   */
  #onChatFileOpen(e) {
    const { path, line } = /** @type {CustomEvent<{ path: string, line?: number | null }>} */ (e).detail;
    this.#main.openFile(path, line);
    this.#revealInTree(path);
  }

  /**
   * A folder named in the chat: only its row in the file tree, expanded to show what's in it.
   * @param {Event} e
   */
  #onChatFileReveal(e) {
    this.#revealInTree(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path, { expand: true });
  }

  /**
   * Reveal in Files, from an editor's footer: a file's row, or a folder's, expanded.
   * @param {Event} e
   */
  #onFileReveal(e) {
    const { path, expand } = /** @type {CustomEvent<{ path: string, expand: boolean }>} */ (e).detail;
    this.#revealInTree(path, { expand });
  }

  /**
   * @param {string} path Absolute; outside the shown folder and its twins there's no row to show.
   * @param {{ expand?: boolean }} [options] Expand a folder itself too.
   */
  async #revealInTree(path, options) {
    // The tree lists the shown folder (the project's or a workspace's); a path of the project or of
    // another worktree is shown by its twin there.
    const rel = projects.relPath(path) ?? projects.rel(projects.path(), projects.projectPathOf($worktrees.get(), path));
    if (rel === null) return;
    this.sideView = 'files';
    showColumn('side');
    await this.updateComplete;
    this.#files.reveal(rel, options);
  }

  /** @param {Event} e */
  #onDiffOpen(e) {
    this.#main.showChange(/** @type {CustomEvent<{ path: string }>} */ (e).detail.path);
  }

  /** @param {Event} e */
  #onPaletteGoToLine(e) {
    this.#main.goToLine(/** @type {CustomEvent<{ line: number }>} */ (e).detail.line);
  }

  /** @type {import('../../hooks/settings/types.js').ColumnWidths} The shown project's panel height as the split takes it; the same object until it changes. */
  #panelWidthsOf = {};

  get #panelWidths() {
    const height = this.#panelHeight.value;
    if ((this.#panelWidthsOf.terminals ?? null) !== height) this.#panelWidthsOf = height === null ? {} : { terminals: height };
    return this.#panelWidthsOf;
  }

  /** @param {CustomEvent<{ widths: import('../../hooks/settings/types.js').ColumnWidths }>} e */
  #onColumnsResize = (e) => {
    e.stopPropagation();
    $columnWidths.set(e.detail.widths);
  };

  /** @param {CustomEvent<{ widths: import('../../hooks/settings/types.js').ColumnWidths }>} e */
  #onPanelResize = (e) => {
    e.stopPropagation();
    const height = e.detail.widths.terminals;
    if (height === undefined) clearTerminalPanelHeight();
    else setTerminalPanelHeight(height);
  };

  render() {
    const hasCode = this.#activePath.value !== null;
    const hidden = this.#hiddenColumns.value;
    // Expanded, the editor takes the agent column's room; with no tab open the agent column is shown anyway.
    const expanded = hasCode && hidden.includes('agent');
    const panelShown = this.#terminalPanel.value.open && this.#terminalTabs.value.paths.length > 0;
    const picker = { list: this.#pickerWorkspaces.value, statuses: this.#workspaceStatuses.value };
    const workspaceId = this.#workspaceId.value;
    return html`<acp-panel variant="window">
      <acp-toolbar
        slot="header"
        .project=${this.#project.value}
        .projects=${this.#projects.value}
        .unread=${projects.unreadByProject($sessions.get(), this.#unread.value)}
        .home=${this.home}
        .git=${this.#gitRepo.value}
        .githubSlot=${github.slot(this.#gitRepo.value.repo, this.#githubAccount.value, this.#pullRequest.value?.reply ?? null)}
        .githubReply=${this.#pullRequest.value?.reply ?? null}
        .hiddenColumns=${hidden}
        ?expandable=${hasCode}
        .workspaces=${picker.list}
        .workspaceStatuses=${picker.statuses}
        .workspaceNumbers=${this.#workspaceNumbers.value}
        .workspaceId=${workspaceId === MAIN ? null : workspaceId}
        ?workspaces-enabled=${this.#workspacesEnabled}
        @acp-workspace-select=${this.#onWorkspaceEvent}
        @acp-workspace-new=${this.#onWorkspaceEvent}
        @acp-workspace-rename=${this.#onWorkspaceEvent}
        @acp-workspace-delete-request=${this.#onWorkspaceEvent}
        @acp-workspace-changes=${this.#onWorkspaceEvent}
        @acp-workspace-apply=${this.#onWorkspaceEvent}
        @acp-workspace-check-out=${this.#onWorkspaceEvent}
        @acp-open-terminal=${this.#onWorkspaceEvent}
        @acp-reveal-path=${this.#onRevealPath}
        @acp-column-toggle=${this.#onColumnToggle}
        @acp-project-select=${this.#onProjectSelect}
        @acp-project-open-folder=${this.#onProjectOpenFolder}
        @acp-project-reveal=${this.#onProjectReveal}
        @acp-project-open-terminal=${this.#openProjectTerminal}
        @acp-project-remove=${this.#onProjectRemove}
        @acp-copy=${this.#onBranchCopy}
        @acp-github-open=${this.#onGithubOpen}
      ></acp-toolbar>
      <!-- With no tabs, the main column is hidden and the agent column takes the space. The terminal panel sits under both, only while the shown project's is open. -->
      <acp-column-split
        .columns=${expanded ? COLUMNS_MAIN_ONLY : hasCode ? COLUMNS : COLUMNS_AGENT_ONLY}
        .widths=${this.#columnWidths.value}
        .hiddenColumns=${hidden}
        @acp-columns-resize=${this.#onColumnsResize}
      >
        <acp-session-column slot="session"></acp-session-column>
        <acp-column-split
          slot="center"
          direction="column"
          flush
          .columns=${CENTER_COLUMNS}
          .widths=${this.#panelWidths}
          .hiddenColumns=${panelShown ? NO_COLUMNS : NO_PANEL}
          @acp-columns-resize=${this.#onPanelResize}
        >
          <acp-column-split
            slot="middle"
            flush
            .columns=${MIDDLE_COLUMNS}
            .widths=${this.#columnWidths.value}
            .hiddenColumns=${expanded ? NO_AGENT : hasCode ? NO_COLUMNS : NO_MAIN}
            .fillColumns=${hasCode ? NO_COLUMNS : AGENT_FILLS}
            @acp-columns-resize=${this.#onColumnsResize}
          >
            <acp-agent-column
              slot="agent"
              @acp-file-open=${this.#onChatFileOpen}
              @acp-file-reveal=${this.#onChatFileReveal}
            ></acp-agent-column>
            <acp-main-column slot="main" @acp-file-reveal=${this.#onFileReveal}></acp-main-column>
          </acp-column-split>
          <acp-terminals-view slot="terminals"></acp-terminals-view>
        </acp-column-split>
        <acp-file-column
          slot="side"
          @acp-file-open=${this.#onFileOpen}
          @acp-diff-open=${this.#onDiffOpen}
        ></acp-file-column>
        <acp-nav-rail
          .selected=${this.sideView}
          @acp-show-files=${this.#showFiles}
          @acp-find-in-files=${this.#showSearch}
          @acp-show-changes=${this.#showChanges}
          @acp-open-terminal=${this.#openProjectTerminal}
          @acp-show-settings=${this.#showSettings}
        ></acp-nav-rail>
      </acp-column-split>
    </acp-panel>
      <acp-quick-open
        .hasProject=${this.#rootId.value !== null}
        .files=${this.quickOpenFiles}
        @acp-quick-open-query=${this.#onPaletteQuery}
        @acp-quick-open-pick=${this.#onPalettePick}
        @acp-go-to-line=${this.#onPaletteGoToLine}
      ></acp-quick-open>
      <acp-search-view @acp-search-open=${this.#onSearchOpen} @acp-search-popout=${this.#onSearchPopout}></acp-search-view>
      <acp-about-dialog .about=${this.#about.value} @acp-reveal-path=${this.#onRevealPath}></acp-about-dialog>
      <acp-confirm-dialog class="acp-app__trust"></acp-confirm-dialog>
      <acp-confirm-dialog class="acp-app__confirm"></acp-confirm-dialog>
      <acp-workspace-dialog
        .projects=${this.#projects.value}
        .projectPath=${this.#project.value?.path ?? null}
        .branches=${this.branches}
        .mainBranch=${this.mainBranch}
        .fetchBranches=${this.#fetchBranches}
        @acp-branches-query=${this.#onBranchesQuery}
        @acp-project-select=${this.#onProjectSelect}
        @acp-workspace-create=${this.#onWorkspaceCreate}
      ></acp-workspace-dialog>
      <acp-workspace-delete-dialog @acp-workspace-delete=${this.#onWorkspaceDelete}></acp-workspace-delete-dialog>
      <acp-snackbars
        .notices=${this.#notices.value}
        @acp-notice-dismiss=${(/** @type {CustomEvent<{ id: number }>} */ e) => dismissNotice(e.detail.id)}
        @acp-notice-action=${(/** @type {CustomEvent<{ id: number }>} */ e) => runNoticeAction(e.detail.id)}
        @acp-notices-hold=${(/** @type {CustomEvent<{ held: boolean }>} */ e) => holdNotices(e.detail.held)}
      ></acp-snackbars>
    `;
  }
}

customElements.define('acp-app', AcpApp);
