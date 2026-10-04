import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $collapsedProjects, $projects, toggleProject } from '../../stores/projects.js';
import { $activeSessionId, $sessions } from '../../stores/sessions.js';
import { $workspace } from '../../stores/workspace.js';
import { getHomeDir } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { sessionController } from '../../services/session-controller.js';
import styles from './acp-session-column.css?inline';

/** @typedef {import('../../models/types.js').Project} Project */
/** @typedef {import('../../models/types.js').Session} Session */

const REVEAL_LABEL = /Mac/.test(navigator.userAgent)
  ? 'Show in Finder'
  : /Windows/.test(navigator.userAgent)
    ? 'Show in Explorer'
    : 'Show in File Manager';

/**
 * Compact age: `now`, `12m`, `3h`, `2d`.
 * @param {string} iso
 */
function age(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/**
 * @tag acp-session-column
 * @summary Projects, each expanding into its agent sessions; "+ New" opens a folder, "+" and a context menu per project.
 * @fires acp-session-new `{ projectId }`
 */
export class AcpSessionColumn extends LitElement {
  static properties = {
    home: { state: true },
    menuProject: { state: true },
    activating: { state: true },
  };

  static styles = styles;

  #projects = new StoreController(this, { store: $projects });
  #collapsed = new StoreController(this, { store: $collapsedProjects });
  #sessions = new StoreController(this, { store: $sessions });
  #activeSession = new StoreController(this, { store: $activeSessionId });
  #workspace = new StoreController(this, { store: $workspace });

  constructor() {
    super();
    /** @type {string | null} Shown as `~` in project paths. */
    this.home = null;
    /** @type {Project | null} The project the context menu is open for. */
    this.menuProject = null;
    /** @type {string | null} Id of the project being scanned after a click. */
    this.activating = null;
  }

  connectedCallback() {
    super.connectedCallback();
    getHomeDir()
      .then((home) => (this.home = home.replace(/[\\/]+$/, '')))
      .catch(() => {});
  }

  get #menu() {
    return /** @type {HTMLElementTagNameMap['md-menu']} */ (this.renderRoot.querySelector('md-menu'));
  }

  /** @param {string} path */
  #displayPath(path) {
    const home = this.home;
    return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
      ? `~${path.slice(home.length)}`
      : path;
  }

  /** @param {string} projectId */
  #newSession(projectId) {
    this.dispatchEvent(new CustomEvent('acp-session-new', { detail: { projectId }, bubbles: true, composed: true }));
  }

  /**
   * @param {Project} project
   * @param {number} x Viewport coordinates.
   * @param {number} y
   */
  #openMenu(project, x, y) {
    this.menuProject = project;
    this.#menu.openAtPoint(x, y);
  }

  /**
   * @param {Project} project
   * @param {MouseEvent} e
   */
  #onProjectContextMenu(project, e) {
    e.preventDefault();
    this.#openMenu(project, e.clientX, e.clientY);
  }

  /**
   * Enter/Space toggle, arrows expand/collapse, ContextMenu or Shift+F10 opens the menu.
   * @param {Project} project
   * @param {KeyboardEvent} e
   */
  #onProjectKeydown(project, e) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') this.#onProjectClick(project);
    else if (e.key === 'ArrowRight') toggleProject(project.id, true);
    else if (e.key === 'ArrowLeft') toggleProject(project.id, false);
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
      this.#openMenu(project, rect.left + 24, rect.bottom);
    } else return;
    e.preventDefault();
  }

  /** @param {Event} e */
  #onMenuSelect(e) {
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    const project = this.menuProject;
    if (!project) return;
    if (value === 'new-session') this.#newSession(project.id);
    else if (value === 'reveal')
      projectController.reveal(project.path).catch((err) => console.error('Brama: reveal failed', err));
    else if (value === 'remove') projectController.remove(project.id);
  }

  #onMenuClosed() {
    this.menuProject = null;
  }

  /**
   * Shows a project's workspace (tree, tabs) once its folder is scanned and watched.
   * @param {string} id
   */
  async #activate(id) {
    this.activating = id;
    try {
      await projectController.activate(id);
    } catch (err) {
      console.error('Brama: opening project failed', err);
    } finally {
      if (this.activating === id) this.activating = null;
    }
  }

  /**
   * A click on an inactive project switches to it and expands it; on the active one it toggles.
   * @param {Project} project
   */
  #onProjectClick(project) {
    if (project.id === this.#workspace.value?.path) {
      toggleProject(project.id);
      return;
    }
    toggleProject(project.id, true);
    this.#activate(project.id);
  }

  #openProject() {
    projectController.open().catch((err) => console.error('Brama: open folder failed', err));
  }

  /** @param {Session} session */
  #select(session) {
    this.#activate(session.projectId);
    sessionController.select(session.id).catch((err) => console.error('Brama: selecting session failed', err));
  }

  /** @param {Event} e */
  #onSessionKeydown(e) {
    const key = /** @type {KeyboardEvent} */ (e).key;
    if (key !== 'Enter' && key !== ' ') return;
    e.preventDefault();
    /** @type {HTMLElement} */ (e.currentTarget).click();
  }

  /**
   * @param {Project} project
   * @param {Session[]} sessions Of this project.
   */
  #renderProject(project, sessions) {
    const expanded = !this.#collapsed.value.includes(project.id);
    return html`
      <div
        class=${classMap({
          'acp-session-column__project': true,
          'acp-session-column__project_menu-open': this.menuProject?.id === project.id,
          'acp-session-column__project_loading': this.activating === project.id,
        })}
        role="treeitem"
        tabindex="0"
        aria-expanded=${expanded ? 'true' : 'false'}
        title=${project.path}
        @click=${() => this.#onProjectClick(project)}
        @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onProjectKeydown(project, e)}
        @contextmenu=${(/** @type {MouseEvent} */ e) => this.#onProjectContextMenu(project, e)}
      >
        <md-icon class="acp-session-column__chevron">${unsafeSVG(expanded ? expandMoreIcon : chevronRightIcon)}</md-icon>
        <span
          class=${classMap({
            'acp-session-column__project-name': true,
            'acp-session-column__project-name_active': this.#workspace.value?.path === project.id,
          })}
          >${project.name}</span
        >
        <span class="acp-session-column__project-path">${this.#displayPath(project.path)}</span>
        ${!expanded && sessions.length > 0
          ? html`<span class="acp-session-column__count">${sessions.length}</span>`
          : nothing}
        <md-icon-button
          class="acp-session-column__add"
          title="New session"
          aria-label=${`New session in ${project.name}`}
          @click=${(/** @type {Event} */ e) => {
            e.stopPropagation();
            this.#newSession(project.id);
          }}
        >
          <md-icon class="acp-session-column__add-icon">${unsafeSVG(addIcon)}</md-icon>
        </md-icon-button>
      </div>
      ${expanded
        ? sessions.length > 0
          ? html`<div class="acp-session-column__sessions" role="group">
              ${repeat(sessions, (s) => s.id, (s) => this.#renderSession(s))}
            </div>`
          : html`<div class="acp-session-column__empty">
              No sessions yet. Press
              <md-icon class="acp-session-column__empty-icon">${unsafeSVG(addIcon)}</md-icon>
              to start one.
            </div>`
        : nothing}
    `;
  }

  /** @param {Session} session */
  #renderSession(session) {
    const selected = session.id === this.#activeSession.value;
    return html`<div
      class=${classMap({ 'acp-session-column__session': true, 'acp-session-column__session_selected': selected })}
      role="treeitem"
      tabindex="0"
      aria-selected=${selected ? 'true' : 'false'}
      @click=${() => this.#select(session)}
      @keydown=${this.#onSessionKeydown}
    >
      <span
        class="acp-session-column__status acp-session-column__status_${session.status}"
        role="img"
        aria-label=${session.status}
      ></span>
      <span class="acp-session-column__session-title">${session.title}</span>
      <span class="acp-session-column__session-age">${age(session.createdAt)}</span>
    </div>`;
  }

  #renderMenu() {
    return html`<md-menu
      class="acp-session-column__menu"
      aria-label=${this.menuProject?.name ?? 'Project'}
      @select=${this.#onMenuSelect}
      @closed=${this.#onMenuClosed}
    >
      <md-menu-item class="acp-session-column__menu-item" value="new-session">
        <md-icon slot="leading" class="acp-session-column__menu-icon">${unsafeSVG(addIcon)}</md-icon>
        New Session
      </md-menu-item>
      <md-menu-item class="acp-session-column__menu-item" value="reveal">
        <md-icon slot="leading" class="acp-session-column__menu-icon">${unsafeSVG(folderOpenIcon)}</md-icon>
        ${REVEAL_LABEL}
      </md-menu-item>
      <md-hr></md-hr>
      <md-menu-item class="acp-session-column__menu-item" value="remove">
        <md-icon slot="leading" class="acp-session-column__menu-icon">${unsafeSVG(closeIcon)}</md-icon>
        Remove project
      </md-menu-item>
    </md-menu>`;
  }

  render() {
    const projects = this.#projects.value;
    const sessions = this.#sessions.value;
    return html`
      <h2 class="acp-session-column__title">Projects</h2>
      <md-button class="acp-session-column__new" variant="tonal" @click=${this.#openProject}>
        <md-icon slot="icon" class="acp-session-column__new-icon">${unsafeSVG(addIcon)}</md-icon>
        New
      </md-button>
      <div class="acp-session-column__list" role="tree" aria-label="Projects">
        ${repeat(
          projects,
          (p) => p.id,
          (p) =>
            this.#renderProject(
              p,
              sessions.filter((s) => s.projectId === p.id),
            ),
        )}
      </div>
      ${this.#renderMenu()}
    `;
  }
}

customElements.define('acp-session-column', AcpSessionColumn);
