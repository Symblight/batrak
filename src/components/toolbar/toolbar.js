import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import '../remote-chip/remote-chip.js';
import sidebarIcon from '@material-design-icons/svg/outlined/view_sidebar.svg?raw';
import expandIcon from '@material-design-icons/svg/outlined/open_in_full.svg?raw';
import collapseIcon from '@material-design-icons/svg/outlined/close_fullscreen.svg?raw';
import styles from './toolbar.css?inline';

/** @typedef {import('../../hooks/git/types.js').GitRepoView} GitRepoView */
/** @typedef {import('../../hooks/projects/types.js').Workspace} Workspace */

/**
 * @tag acp-toolbar
 * @summary Narrow app-wide bar above the columns: the opened folder's name and git branch, and the
 *   buttons hiding the sessions and file columns, and the one expanding the editor over the agent column.
 * @fires acp-column-toggle `{ column }`
 */
export class AcpToolbar extends LitElement {
  static properties = {
    workspace: { attribute: false },
    git: { attribute: false },
    hiddenColumns: { attribute: false },
    expandable: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Workspace | null} */
    this.workspace = null;
    /** @type {GitRepoView} */
    this.git = { repo: null, error: null };
    /** @type {string[]} Names of the hidden columns. */
    this.hiddenColumns = [];
    /** @type {boolean} A tab is open, so the editor can take the agent column's room. */
    this.expandable = false;
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
    const name = repo.detached ? (repo.sha?.slice(0, 7) ?? 'HEAD') : (repo.branch ?? '');
    const title = [
      repo.detached ? `Detached HEAD at ${repo.sha ?? ''}` : `Branch ${repo.branch}`,
      repo.upstream ? `tracking ${repo.upstream}` : 'no upstream',
    ]
      .filter(Boolean)
      .join(', ');
    return html`<span id="acp-toolbar-branch" class="acp-toolbar__branch">${name}</span>
      <md-tooltip for="acp-toolbar-branch" show-delay="800" placement="bottom">${title}</md-tooltip>
      <acp-remote-chip .repo=${repo}></acp-remote-chip>`;
  }

  render() {
    const workspace = this.workspace;
    return html`${this.#renderColumnToggle('session', 'sessions column', 'start')}
      <span id="acp-toolbar-name" class="acp-toolbar__name">${workspace?.name ?? ''}</span>
      ${workspace
        ? html`<md-tooltip for="acp-toolbar-name" show-delay="800" placement="bottom" style="width: max-content; max-inline-size: none"
            >${workspace.path}</md-tooltip
          >`
        : nothing}
      ${workspace ? this.#renderBranch(this.git) : nothing}
      <span class="acp-toolbar__spacer"></span>
      ${this.expandable ? this.#renderExpand() : nothing} ${this.#renderColumnToggle('side', 'file column', 'end')}`;
  }
}

customElements.define('acp-toolbar', AcpToolbar);
