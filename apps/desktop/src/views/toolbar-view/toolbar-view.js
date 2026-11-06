import { html } from 'lit';
import { app } from '../../hooks/app/app.js';
import { git } from '../../hooks/git/git.js';
import { github } from '../../hooks/github/github.js';
import { projects } from '../../hooks/projects/projects.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { $activePath } from '../../stores/editor/editor.js';
import { $gitCompare, $gitRepo } from '../../stores/git/git.js';
import { $githubAccount, $pullRequestHere } from '../../stores/github/github.js';
import { $shownHiddenColumns, toggleColumn } from '../../stores/layout/layout.js';
import { $project } from '../../stores/project/project.js';
import { $projects, toggleProject } from '../../stores/projects/projects.js';
import { $unreadSessions } from '../../stores/session-read/session-read.js';
import { $sessions } from '../../stores/sessions/sessions.js';
import { $pickerWorkspaces, $workspaceNumbers, $workspaceStatuses, $workspacesEnabled } from '../../stores/workspace-status/workspace-status.js';
import { $activeWorkspaceId, $rootId, MAIN } from '../../stores/workspaces/workspaces.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/toolbar/toolbar.js';
import { ViewElement } from '../../components/view-element/view-element.js';

/**
 * @tag acp-toolbar-view
 * @summary The toolbar wired to its data: the project menu and its Remove dialog, the workspace picker, the branch and its pull request, the column buttons.
 */
export class AcpToolbarView extends ViewElement {
  static properties = {
    home: { state: true },
    branches: { state: true },
  };

  #project = new StoreController(this, { store: $project });
  #projects = new StoreController(this, { store: $projects });
  #unread = new StoreController(this, { store: $unreadSessions });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #gitCompare = new StoreController(this, { store: $gitCompare });
  #githubAccount = new StoreController(this, { store: $githubAccount });
  #pullRequest = new StoreController(this, { store: $pullRequestHere });
  #hiddenColumns = new StoreController(this, { store: $shownHiddenColumns });
  #activePath = new StoreController(this, { store: $activePath });
  #workspaceId = new StoreController(this, { store: $activeWorkspaceId });
  #pickerWorkspaces = new StoreController(this, { store: $pickerWorkspaces });
  #workspacesEnabled = new StoreController(this, { store: $workspacesEnabled });
  #workspaceStatuses = new StoreController(this, { store: $workspaceStatuses });
  #workspaceNumbers = new StoreController(this, { store: $workspaceNumbers });

  constructor() {
    super();
    /** @type {string | null} Shown as `~` in the project menu's paths. */
    this.home = null;
    /** @type {import('../../hooks/git/types.js').BranchList} What the branch card can compare to, as of its menu's last opening. */
    this.branches = { local: [], remotes: [], default: null };
  }

  /** As of the last fetch: fetching is the terminal's, and would keep the menu waiting. */
  #loadBranches = async () => {
    const rootId = $rootId.get();
    if (rootId === null) return;
    /** @type {import('../../hooks/git/types.js').BranchList} */
    let list = { local: [], remotes: [], default: null };
    try {
      list = git.compareBranches(await git.branches(rootId), $gitRepo.get().repo);
    } catch (err) {
      app.reportError('Listing the branches failed', err);
    }
    if ($rootId.get() === rootId) this.branches = list;
  };

  connectedCallback() {
    super.connectedCallback();
    projects
      .homeDir()
      .then((home) => (this.home = home.replace(/[\\/]+$/, '')))
      .catch(() => {});
  }

  /** Opens the workspace picker's menu. */
  showWorkspaces() {
    this.renderRoot.querySelector('acp-toolbar')?.showWorkspaces();
  }

  /** New workspace: a new chat of the shown workspace, set to run in a new worktree (created on its first message). */
  newWorkspace() {
    const project = this.#project.value?.path ?? null;
    if (project !== null) sessions.create(project, $activeWorkspaceId.get(), { kind: 'worktree', base: null });
  }

  /** Add project: the folder picker. */
  openFolder() {
    projects.open().catch((err) => app.reportError('Opening folder failed', err));
  }

  /** @param {Event} e */
  #onWorkspaceEvent = (e) => {
    const detail = /** @type {CustomEvent<{ id: string, name: string, path: string }>} */ (e).detail;
    switch (e.type) {
      case 'acp-workspace-select':
        workspaces.select(detail.id);
        break;
      case 'acp-workspace-new':
        this.newWorkspace();
        break;
      case 'acp-workspace-rename':
        void workspaces.rename(detail.id, detail.name);
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
  #onRevealPath = (e) => {
    const { path } = /** @type {CustomEvent<{ path: string }>} */ (e).detail;
    projects.reveal(path).catch((err) => app.log('warn', `showing logs failed: ${err}`));
  };

  /** @param {Event} e */
  #onColumnToggle = (e) => {
    toggleColumn(/** @type {CustomEvent<{ column: string }>} */ (e).detail.column);
  };

  /** @param {Event} e */
  #onProjectSelect = (e) => {
    const id = /** @type {CustomEvent<{ projectId: string }>} */ (e).detail.projectId;
    toggleProject(id, true);
    projects.activate(id).catch((err) => app.reportError('Opening project failed', err));
  };

  /** @param {Event} e */
  #onProjectRemove = (e) => {
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (this.renderRoot.querySelector('acp-confirm-dialog'));
    projects.confirmRemove(/** @type {CustomEvent<{ projectId: string }>} */ (e).detail.projectId, dialog);
  };

  /** @param {Event} e */
  #onBranchCopy = (e) => app.copy(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text, 'Copying the branch name failed');

  /** @param {Event} e */
  #onGithubOpen = (e) => {
    app.openUrl(/** @type {CustomEvent<{ url: string }>} */ (e).detail.url).catch((err) => app.reportError('Opening the page failed', err));
  };

  render() {
    const workspaceId = this.#workspaceId.value;
    const reply = this.#pullRequest.value?.reply ?? null;
    return html`<acp-toolbar
        .project=${this.#project.value}
        .projects=${this.#projects.value}
        .unread=${projects.unreadByProject($sessions.get(), this.#unread.value)}
        .home=${this.home}
        .git=${this.#gitRepo.value}
        .compareTo=${this.#gitCompare.value.target}
        .branches=${this.branches}
        .loadBranches=${this.#loadBranches}
        .githubSlot=${github.slot(this.#gitRepo.value.repo, this.#githubAccount.value, reply)}
        .githubReply=${reply}
        .hiddenColumns=${this.#hiddenColumns.value}
        ?expandable=${this.#activePath.value !== null}
        .workspaces=${this.#pickerWorkspaces.value}
        .workspaceStatuses=${this.#workspaceStatuses.value}
        .workspaceNumbers=${this.#workspaceNumbers.value}
        .workspaceId=${workspaceId === MAIN ? null : workspaceId}
        ?workspaces-enabled=${this.#workspacesEnabled.value}
        @acp-workspace-select=${this.#onWorkspaceEvent}
        @acp-workspace-new=${this.#onWorkspaceEvent}
        @acp-workspace-rename=${this.#onWorkspaceEvent}
        @acp-workspace-changes=${this.#onWorkspaceEvent}
        @acp-workspace-apply=${this.#onWorkspaceEvent}
        @acp-workspace-check-out=${this.#onWorkspaceEvent}
        @acp-open-terminal=${this.#onWorkspaceEvent}
        @acp-reveal-path=${this.#onRevealPath}
        @acp-column-toggle=${this.#onColumnToggle}
        @acp-project-select=${this.#onProjectSelect}
        @acp-project-open-folder=${this.openFolder}
        @acp-project-remove=${this.#onProjectRemove}
        @acp-copy=${this.#onBranchCopy}
        @acp-github-open=${this.#onGithubOpen}
      ></acp-toolbar>
      <acp-confirm-dialog></acp-confirm-dialog>`;
  }
}

customElements.define('acp-toolbar-view', AcpToolbarView);
