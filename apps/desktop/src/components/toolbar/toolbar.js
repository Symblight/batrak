import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import '../branch-popover/branch-popover.js';
import '../project-menu/project-menu.js';
import '../pull-request-chip/pull-request-chip.js';
import '../update-button/update-button.js';
import '../workspace-picker/workspace-picker.js';
import sidebarIcon from '@material-design-icons/svg/outlined/view_sidebar.svg?raw';
import expandIcon from '@material-design-icons/svg/outlined/fullscreen.svg?raw';
import collapseIcon from '@material-design-icons/svg/outlined/fullscreen_exit.svg?raw';
import styles from './toolbar.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/projects/types.js').OpenProject} OpenProject */

/**
 * @tag acp-toolbar
 * @summary Narrow app-wide bar above the columns: the project menu, the workspace picker and git branch (a card with its remote and pull request), the update button, and the
 *   buttons hiding the sessions and file columns, and the one expanding the editor over the agent column.
 * @fires acp-column-toggle `{ column }`
 * @fires acp-github-open `{ url }` From the GitHub slot and the branch card.
 * @fires acp-copy `{ text }` From the branch card.
 * @fires acp-compare-pick `{ branch }` From the branch card.
 */
export class AcpToolbar extends LitElement {
  static properties = {
    project: { attribute: false },
    projects: { attribute: false },
    unread: { attribute: false },
    home: {},
    git: { attribute: false },
    compareTo: { attribute: false },
    branches: { attribute: false },
    loadBranches: { attribute: false },
    githubSlot: { attribute: false },
    githubReply: { attribute: false },
    hiddenColumns: { attribute: false },
    expandable: { type: Boolean },
    workspaces: { attribute: false },
    workspaceStatuses: { attribute: false },
    workspaceNumbers: { attribute: false },
    workspaceId: { attribute: false },
    workspacesEnabled: { type: Boolean, attribute: 'workspaces-enabled' },
    appUpdate: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {OpenProject | null} */
    this.project = null;
    /** @type {readonly import('../../hooks/projects/types.js').Project[]} The project menu's list. */
    this.projects = [];
    /** @type {Readonly<Record<string, number>>} Unread sessions by project id, for the menu's dots. */
    this.unread = {};
    /** @type {string | null} Shown as `~` in the menu's paths. */
    this.home = null;
    /** @type {GitRepoView} */
    this.git = { repo: null, error: null };
    /** @type {string | null} The branch the Changes views show the diff of. */
    this.compareTo = null;
    /** @type {import('../../hooks/git/types.js').BranchList} What the branch card can compare to. */
    this.branches = { local: [], remotes: [], default: null };
    /** @type {(() => Promise<void>) | null} Brings `branches` up to date. */
    this.loadBranches = null;
    /** @type {import('../../hooks/github/types.js').GithubSlot} What the GitHub slot beside the branch shows. */
    this.githubSlot = 'hidden';
    /** @type {import('../../hooks/github/types.js').GithubPrReply | null} The shown branch's pull request lookup. */
    this.githubReply = null;
    /** @type {string[]} Names of the hidden columns. */
    this.hiddenColumns = [];
    /** @type {boolean} A tab is open, so the editor can take the agent column's room. */
    this.expandable = false;
    /** @type {readonly import('../../hooks/workspaces/types.js').Workspace[]} The picker's Active group, in order. */
    this.workspaces = [];
    /** @type {Readonly<Record<string, import('../../hooks/workspaces/types.js').WorkspaceStatus>>} By id, Main's under `main`. */
    this.workspaceStatuses = {};
    /** @type {Readonly<Record<string, number>>} Each workspace's shortcut number by id, Main's under `main`. */
    this.workspaceNumbers = {};
    /** @type {string | null} The shown workspace; `null` for Main. */
    this.workspaceId = null;
    /** @type {boolean} The project can have workspaces: git with a commit. */
    this.workspacesEnabled = false;
    /** @type {import('../../hooks/app-update/types.js').AppUpdateState} */
    this.appUpdate = { state: 'none' };
  }

  /** Button hiding the agent column, so the editor's tabs take the whole middle. */
  #renderExpand() {
    const id = 'acp-toolbar-toggle-agent';
    const expanded = this.hiddenColumns.includes('agent');
    const tooltip = expanded ? 'Collapse editor' : 'Expand editor';
    return html`<md-icon-button
        id=${id}
        class="acp-toolbar__toggle"
        aria-label=${tooltip}
        ?selected=${expanded}
        @click=${() => this.#toggle('agent')}
      >
        <md-icon class="acp-toolbar__toggle-icon">${unsafeSVG(expanded ? collapseIcon : expandIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for=${id} show-delay="800" placement="bottom">${tooltip}</md-tooltip>`;
  }

  /**
   * Button showing or hiding a column, with its tooltip.
   * @param {string} column Column name in `hiddenColumns`.
   * @param {string} label Column's name in the tooltip, e.g. "sessions column".
   * @param {'start' | 'end'} side Where the column is; the icon's panel is drawn on that side.
   */
  #renderColumnToggle(column, label, side) {
    const id = `acp-toolbar-toggle-${column}`;
    const shown = !this.hiddenColumns.includes(column);
    const tooltip = `${shown ? 'Hide' : 'Show'} ${label}`;
    return html`<md-icon-button
        id=${id}
        class="acp-toolbar__toggle"
        aria-label=${tooltip}
        ?selected=${shown}
        @click=${() => this.#toggle(column)}
      >
        <md-icon class="acp-toolbar__toggle-icon ${side === 'start' ? 'acp-toolbar__toggle-icon_start' : ''}"
          >${unsafeSVG(sidebarIcon)}</md-icon
        >
      </md-icon-button>
      <md-tooltip for=${id} show-delay="800" placement="bottom">${tooltip}</md-tooltip>`;
  }

  /** @param {string} column */
  #toggle(column) {
    this.dispatchEvent(new CustomEvent('acp-column-toggle', { detail: { column }, bubbles: true, composed: true }));
  }

  /** @param {GitRepoView} git */
  #renderBranch({ repo, error }) {
    if (error) {
      return html`<span id="acp-toolbar-git-error" class="acp-toolbar__git-error">Git unavailable</span>
        <md-tooltip for="acp-toolbar-git-error" show-delay="800" placement="bottom">${error}</md-tooltip>`;
    }
    if (!repo) return nothing;
    return html`<acp-branch-popover
        .repo=${repo}
        .pr=${this.githubReply?.pr ?? null}
        .compareTo=${this.compareTo}
        .branches=${this.branches}
        .loadBranches=${this.loadBranches}
      ></acp-branch-popover>
      <acp-pull-request-chip .status=${this.githubSlot} .reply=${this.githubReply} .repo=${repo}></acp-pull-request-chip>`;
  }

  /** Opens the workspace picker's menu. */
  showWorkspaces() {
    this.renderRoot.querySelector('acp-workspace-picker')?.show();
  }

  render() {
    const project = this.project;
    return html`${this.#renderColumnToggle('session', 'sessions column', 'start')}
      <acp-project-menu
        .projects=${this.projects}
        .currentId=${project?.path ?? null}
        .unread=${this.unread}
        .home=${this.home}
      ></acp-project-menu>
      ${project
        ? html`<acp-workspace-picker
            .workspaces=${this.workspaces}
            .statuses=${this.workspaceStatuses}
            .numbers=${this.workspaceNumbers}
            .currentId=${this.workspaceId}
            .projectName=${project.name}
            .projectPath=${project.path}
            ?enabled=${this.workspacesEnabled}
          ></acp-workspace-picker>`
        : nothing}
      ${project && (this.git.repo || this.git.error) ? html`<span class="acp-toolbar__divider"></span>` : nothing}
      ${project ? this.#renderBranch(this.git) : nothing}
      <span class="acp-toolbar__spacer"></span>
      <acp-update-button .state=${this.appUpdate}></acp-update-button>
      ${this.expandable ? this.#renderExpand() : nothing} ${this.#renderColumnToggle('side', 'file column', 'end')}`;
  }
}

customElements.define('acp-toolbar', AcpToolbar);
