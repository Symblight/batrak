import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import '../branch-popover/branch-popover.js';
import '../project-menu/project-menu.js';
import '../pull-request-chip/pull-request-chip.js';
import '../remote-chip/remote-chip.js';
import sidebarIcon from '@material-design-icons/svg/outlined/view_sidebar.svg?raw';
import expandIcon from '@material-design-icons/svg/outlined/open_in_full.svg?raw';
import collapseIcon from '@material-design-icons/svg/outlined/close_fullscreen.svg?raw';
import styles from './toolbar.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/git/types.js').GitRemoteOp} GitRemoteOp */
/** @typedef {import('../../hooks/projects/types.js').Workspace} Workspace */

/**
 * @tag acp-toolbar
 * @summary Narrow app-wide bar above the columns: the project menu and git branch (a popover to switch it), and the
 *   buttons hiding the sessions and file columns, and the one expanding the editor over the agent column.
 * @fires acp-column-toggle `{ column }`
 * @fires acp-git-remote `{ action }` From the remote chip.
 * @fires acp-github-sign-in `null` From the GitHub slot.
 * @fires acp-github-open `{ url }` From the GitHub slot.
 * @fires acp-git-branches-query `null` From the branch popover.
 * @fires acp-git-switch `{ branch, create }` From the branch popover.
 * @fires acp-copy `{ text }` From the branch popover.
 */
export class AcpToolbar extends LitElement {
  static properties = {
    workspace: { attribute: false },
    projects: { attribute: false },
    unread: { attribute: false },
    home: {},
    git: { attribute: false },
    remoteOp: { attribute: false },
    fetchError: { attribute: false },
    githubSlot: { attribute: false },
    githubReply: { attribute: false },
    branches: { attribute: false },
    hiddenColumns: { attribute: false },
    expandable: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Workspace | null} */
    this.workspace = null;
    /** @type {readonly import('../../hooks/projects/types.js').Project[]} The project menu's list. */
    this.projects = [];
    /** @type {Readonly<Record<string, number>>} Unread sessions by project id, for the menu's dots. */
    this.unread = {};
    /** @type {string | null} Shown as `~` in the menu's paths. */
    this.home = null;
    /** @type {GitRepoView} */
    this.git = { repo: null, error: null };
    /** @type {GitRemoteOp | null} The fetch, pull or push running or failed for the shown project. */
    this.remoteOp = null;
    /** @type {import('../../hooks/git/types.js').GitFetchError | null} Why the shown project's last background fetch failed. */
    this.fetchError = null;
    /** @type {import('../../hooks/github/types.js').GithubSlot} What the GitHub slot beside the remote chip shows. */
    this.githubSlot = 'hidden';
    /** @type {import('../../hooks/github/types.js').GithubPrReply | null} The shown branch's pull request lookup. */
    this.githubReply = null;
    /** @type {import('../../hooks/git/types.js').GitBranchList | null} The branch popover's lists, once asked for. */
    this.branches = null;
    /** @type {string[]} Names of the hidden columns. */
    this.hiddenColumns = [];
    /** @type {boolean} A tab is open, so the editor can take the agent column's room. */
    this.expandable = false;
  }

  /**
   * The container's answer to a switch, passed on to the branch popover.
   * @param {string | null} error `null`: it worked; else why it was refused.
   */
  switchFinished(error) {
    this.renderRoot.querySelector('acp-branch-popover')?.switchFinished(error);
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
    return html`<acp-branch-popover .repo=${repo} .branches=${this.branches}></acp-branch-popover>
      <acp-remote-chip .repo=${repo} .op=${this.remoteOp} .fetchError=${this.fetchError}></acp-remote-chip>
      <acp-pull-request-chip .status=${this.githubSlot} .reply=${this.githubReply} .repo=${repo}></acp-pull-request-chip>`;
  }

  render() {
    const workspace = this.workspace;
    return html`${this.#renderColumnToggle('session', 'sessions column', 'start')}
      <acp-project-menu
        .projects=${this.projects}
        .currentId=${workspace?.path ?? null}
        .unread=${this.unread}
        .home=${this.home}
      ></acp-project-menu>
      ${workspace ? this.#renderBranch(this.git) : nothing}
      <span class="acp-toolbar__spacer"></span>
      ${this.expandable ? this.#renderExpand() : nothing} ${this.#renderColumnToggle('side', 'file column', 'end')}`;
  }
}

customElements.define('acp-toolbar', AcpToolbar);
