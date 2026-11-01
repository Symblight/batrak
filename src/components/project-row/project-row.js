import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import styles from './project-row.css?inline';

/** @typedef {import('../../models/types/types.js').Project} Project */

/**
 * @tag acp-project-row
 * @summary A project in the session list: its chevron, name, path, the count of its hidden sessions and a button for a new one.
 * @fires acp-project-select `{ projectId }`
 * @fires acp-project-toggle `{ projectId, expanded }` From the arrow keys.
 * @fires acp-project-new-session `{ projectId }`
 * @fires acp-project-row-menu `{ project, x, y }` Its menu is wanted, at the pointer or under the focused row.
 */
export class AcpProjectRow extends LitElement {
  static properties = {
    project: { attribute: false },
    path: { type: String },
    expanded: { type: Boolean },
    active: { type: Boolean },
    loading: { type: Boolean },
    menuOpen: { type: Boolean, attribute: 'menu-open' },
    count: { type: Number },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {Project | null} */
    this.project = null;
    /** @type {string} Its path as shown (`~` for the home folder). */
    this.path = '';
    /** @type {boolean} Its sessions are listed. */
    this.expanded = true;
    /** @type {boolean} Its workspace is the open one. */
    this.active = false;
    /** @type {boolean} It is being opened. */
    this.loading = false;
    /** @type {boolean} Its menu is open for it. */
    this.menuOpen = false;
    /** @type {number} How many sessions it has, shown while they are hidden. */
    this.count = 0;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Enter/Space selects, arrows expand/collapse, ContextMenu or Shift+F10 asks for the menu.
   * @param {KeyboardEvent} e
   */
  #onKeydown(e) {
    const project = this.project;
    if (!project || e.target !== e.currentTarget) return;
    const projectId = project.id;
    if (e.key === 'Enter' || e.key === ' ') this.#emit('acp-project-select', { projectId });
    else if (e.key === 'ArrowRight') this.#emit('acp-project-toggle', { projectId, expanded: true });
    else if (e.key === 'ArrowLeft') this.#emit('acp-project-toggle', { projectId, expanded: false });
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      this.#emit('acp-project-row-menu', { project, x: rect.left + 24, y: rect.bottom });
    } else return;
    e.preventDefault();
  }

  /** @param {MouseEvent} e */
  #onContextMenu(e) {
    if (!this.project) return;
    e.preventDefault();
    e.stopPropagation();
    this.#emit('acp-project-row-menu', { project: this.project, x: e.clientX, y: e.clientY });
  }

  render() {
    const project = this.project;
    if (!project) return nothing;
    return html`<div
        class="acp-project-row__row ${this.menuOpen ? 'acp-project-row__row_menu-open' : ''} ${this.loading ? 'acp-project-row__row_loading' : ''}"
        role="treeitem"
        tabindex="0"
        aria-expanded=${this.expanded ? 'true' : 'false'}
        @click=${() => this.#emit('acp-project-select', { projectId: project.id })}
        @keydown=${this.#onKeydown}
        @contextmenu=${this.#onContextMenu}
      >
        <md-icon class="acp-project-row__chevron">${unsafeSVG(this.expanded ? expandMoreIcon : chevronRightIcon)}</md-icon>
        <span class="acp-project-row__name ${this.active ? 'acp-project-row__name_active' : ''}">${project.name}</span>
        <span id="acp-project-row-path" class="acp-project-row__path">${this.path}</span>
        ${!this.expanded && this.count > 0 ? html`<span class="acp-project-row__count">${this.count}</span>` : nothing}
        <md-icon-button
          id="acp-project-row-add"
          class="acp-project-row__add"
          aria-label=${`New session in ${project.name}`}
          @click=${(/** @type {Event} */ e) => {
            e.stopPropagation();
            this.#emit('acp-project-new-session', { projectId: project.id });
          }}
        >
          <md-icon class="acp-project-row__add-icon">${unsafeSVG(addIcon)}</md-icon>
        </md-icon-button>
      </div>
      <md-tooltip for="acp-project-row-path" show-delay="800" style="width: max-content; max-inline-size: none">${project.path}</md-tooltip>
      <md-tooltip for="acp-project-row-add" show-delay="800">New session</md-tooltip>`;
  }
}

customElements.define('acp-project-row', AcpProjectRow);
