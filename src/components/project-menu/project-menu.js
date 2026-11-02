import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import checkIcon from '@material-design-icons/svg/outlined/check.svg?raw';
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import folderIcon from '@material-design-icons/svg/outlined/folder.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import removeIcon from '@material-design-icons/svg/outlined/remove_circle_outline.svg?raw';
import terminalIcon from '@material-design-icons/svg/outlined/terminal.svg?raw';
import { app } from '../../hooks/app/app.js';
import { projects } from '../../hooks/projects/projects.js';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './project-menu.css?inline';

/** @typedef {import('../../hooks/projects/types.js').Project} Project */

/** Menu values that are actions, not projects (a project's value is its id, with `data-project` on the item). */
const ACTIONS = new Set(['open-folder', 'reveal', 'open-terminal', 'remove']);

/**
 * @tag acp-project-menu
 * @summary The header's project button and its menu: the listed projects (the shown one checked, a dot on those with unread sessions), Add project, and the shown project's Reveal, Open in terminal and Remove.
 * @fires acp-project-select `{ projectId }` Another project was picked.
 * @fires acp-project-open-folder `null`
 * @fires acp-project-reveal `{ projectId }` The shown project.
 * @fires acp-project-open-terminal `null` The shown project's.
 * @fires acp-project-remove `{ projectId }` The shown project.
 */
export class AcpProjectMenu extends LitElement {
  static properties = {
    projects: { attribute: false },
    currentId: { attribute: false },
    unread: { attribute: false },
    home: {},
    open: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly Project[]} */
    this.projects = [];
    /** @type {string | null} The shown project's id. */
    this.currentId = null;
    /** @type {Readonly<Record<string, number>>} Unread sessions by project id. */
    this.unread = {};
    /** @type {string | null} Shown as `~` in paths. */
    this.home = null;
    /** @type {boolean} */
    this.open = false;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    const current = this.currentId;
    if (ACTIONS.has(value)) {
      if (value === 'open-folder' || value === 'open-terminal') this.#emit(`acp-project-${value}`, null);
      else if (current !== null) this.#emit(`acp-project-${value}`, { projectId: current });
    } else if (value !== current) this.#emit('acp-project-select', { projectId: value });
  };

  /**
   * @param {Project} project
   * @param {number} index
   */
  #renderProject(project, index) {
    const current = project.id === this.currentId;
    const unread = this.unread[project.id] ?? 0;
    const dotId = `acp-project-menu-dot-${index}`;
    return html`<md-menu-item class="acp-project-menu__item" value=${project.id} data-project=${project.id} ?selected=${current}>
      ${current
        ? html`<md-icon slot="leading" class="acp-project-menu__check">${unsafeSVG(checkIcon)}</md-icon>`
        : html`<span slot="leading" class="acp-project-menu__tile acp-project-menu__tile_small">${projects.initialOf(project.name)}</span>`}
      ${project.name}
      <span class="acp-project-menu__path">${projects.parentLabel(project.path, this.home)}</span>
      ${unread > 0
        ? html`<span slot="trailing" id=${dotId} class="acp-project-menu__dot"></span>
            <md-tooltip slot="trailing" for=${dotId} show-delay="800"
              >${unread} unread ${unread === 1 ? 'session' : 'sessions'}</md-tooltip
            >`
        : nothing}
    </md-menu-item>`;
  }

  /** @param {string} value @param {string} icon @param {string} label @param {string} [hint] */
  #renderAction(value, icon, label, hint) {
    return html`<md-menu-item class="acp-project-menu__item" value=${value}>
      <md-icon slot="leading" class="acp-project-menu__icon">${unsafeSVG(icon)}</md-icon>
      ${label} ${hint ? html`<span slot="trailing">${hint}</span>` : nothing}
    </md-menu-item>`;
  }

  render() {
    const current = this.projects.find((p) => p.id === this.currentId) ?? null;
    const label = current ? `Project ${current.name}` : 'Open project';
    return html`
      <md-button
        id="acp-project-menu-button"
        class="acp-project-menu__button"
        variant="text"
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${this.open ? 'true' : 'false'}
      >
        <span class="acp-project-menu__label">
          ${current
            ? html`<span class="acp-project-menu__tile">${projects.initialOf(current.name)}</span>
                <span class="acp-project-menu__name">${current.name}</span>`
            : html`<md-icon class="acp-project-menu__icon">${unsafeSVG(folderIcon)}</md-icon>
                <span class="acp-project-menu__name">Open project</span>`}
          <md-icon class="acp-project-menu__arrow ${this.open ? 'acp-project-menu__arrow_open' : ''}">${unsafeSVG(expandMoreIcon)}</md-icon>
        </span>
      </md-button>
      <md-tooltip for="acp-project-menu-button" show-delay="800" placement="bottom" style="width: max-content; max-inline-size: none"
        >${current ? `Project · ${projects.tildePath(current.path, this.home)}` : 'Open a project'}</md-tooltip
      >
      <md-menu
        class="acp-project-menu__menu"
        for="acp-project-menu-button"
        placement="bottom-start"
        focus-on-open="selected"
        aria-label="Projects"
        @select=${this.#onSelect}
        @opening=${() => (this.open = true)}
        @closing=${() => (this.open = false)}
      >
        ${this.projects.length
          ? html`<md-item-group>
              <md-menu-group label="Projects">
                ${repeat(this.projects, (p) => p.id, (p, i) => this.#renderProject(p, i))}
              </md-menu-group>
            </md-item-group>`
          : nothing}
        <md-item-group>
          ${this.#renderAction('open-folder', addIcon, 'Add project…', shortcuts.hint('openFolder'))}
        </md-item-group>
        ${current
          ? html`<md-item-group>
              ${this.#renderAction('reveal', folderOpenIcon, app.revealLabel)}
              ${this.#renderAction('open-terminal', terminalIcon, 'Open in terminal')}
              ${this.#renderAction('remove', removeIcon, 'Remove from list')}
            </md-item-group>`
          : nothing}
      </md-menu>
    `;
  }
}

customElements.define('acp-project-menu', AcpProjectMenu);
