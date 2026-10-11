import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import sidebarIcon from '@material-design-icons/svg/outlined/view_sidebar.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $gitRepo } from '../../stores/git.js';
import { $hiddenColumns, toggleColumn } from '../../stores/layout.js';
import { $workspace } from '../../stores/workspace.js';
import styles from './acp-toolbar.css?inline';

/** @typedef {import('../../models/types.js').GitRepoView} GitRepoView */

/**
 * @tag acp-toolbar
 * @summary Narrow app-wide bar above the columns: the opened folder's name and git branch, and the
 *   buttons hiding the sessions and file columns.
 */
export class AcpToolbar extends LitElement {
  static styles = styles;

  #workspace = new StoreController(this, { store: $workspace });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #hiddenColumns = new StoreController(this, { store: $hiddenColumns });

  /**
   * Button showing or hiding a column, with its tooltip.
   * @param {string} column Column name in `$hiddenColumns`.
   * @param {string} label Column's name in the tooltip, e.g. "sessions column".
   * @param {'start' | 'end'} side Where the column is; the icon's panel is drawn on that side.
   */
  #renderColumnToggle(column, label, side) {
    const id = `acp-toolbar-toggle-${column}`;
    const shown = !this.#hiddenColumns.value.includes(column);
    const tooltip = `${shown ? 'Hide' : 'Show'} ${label}`;
    return html`<md-icon-button
        id=${id}
        class="acp-toolbar__toggle"
        aria-label=${tooltip}
        ?selected=${shown}
        @click=${() => toggleColumn(column)}
      >
        <md-icon class="acp-toolbar__toggle-icon ${side === 'start' ? 'acp-toolbar__toggle-icon_start' : ''}"
          >${unsafeSVG(sidebarIcon)}</md-icon
        >
      </md-icon-button>
      <md-tooltip for=${id} placement="bottom">${tooltip}</md-tooltip>`;
  }

  /** @param {GitRepoView} git */
  #renderBranch({ repo, error }) {
    if (error) {
      return html`<span class="acp-toolbar__git-error" title=${error}>Git unavailable</span>`;
    }
    if (!repo) return nothing;
    const name = repo.detached ? (repo.sha?.slice(0, 7) ?? 'HEAD') : (repo.branch ?? '');
    const sync = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ');
    const title = [
      repo.detached ? `Detached HEAD at ${repo.sha ?? ''}` : `Branch ${repo.branch}`,
      repo.upstream ? `tracking ${repo.upstream}` : 'no upstream',
      repo.ahead ? `${repo.ahead} ahead` : '',
      repo.behind ? `${repo.behind} behind` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return html`<span class="acp-toolbar__branch" title=${title}
      >${name}${sync ? html`<span class="acp-toolbar__sync">${sync}</span>` : nothing}</span
    >`;
  }

  render() {
    const workspace = this.#workspace.value;
    return html`${this.#renderColumnToggle('session', 'sessions column', 'start')}
      <span class="acp-toolbar__name" title=${workspace?.path ?? ''}>${workspace?.name ?? ''}</span>
      ${workspace ? this.#renderBranch(this.#gitRepo.value) : nothing}
      <span class="acp-toolbar__spacer"></span>
      ${this.#renderColumnToggle('side', 'file column', 'end')}`;
  }
}

customElements.define('acp-toolbar', AcpToolbar);
