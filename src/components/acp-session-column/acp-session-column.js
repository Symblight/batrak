import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/fab';
import '../acp-confirm-dialog/acp-confirm-dialog.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select'; // registers md-hr, the menu divider
import expandMoreIcon from '@material-design-icons/svg/outlined/expand_more.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import folderOpenIcon from '@material-design-icons/svg/outlined/folder_open.svg?raw';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import { RUNNING, removeSessionConfirm } from '../../models/sessions.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { $collapsedProjects, $projects, toggleProject } from '../../stores/projects.js';
import { $activeSessionId, $sessions } from '../../stores/sessions.js';
import { $openingPath, $workspace } from '../../stores/workspace.js';
import { getHomeDir } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { sessionController } from '../../services/session-controller.js';
import styles from './acp-session-column.css?inline';
import { reportError } from '../../services/notices.js';

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
 * @summary Projects, each expanding into its agent sessions with their status (and a worktree session's branch); "+ New" opens a folder, "+" and a context menu per project, and one per session (rename, log, stop, remove).
 */
export class AcpSessionColumn extends LitElement {
  static properties = {
    home: { state: true },
    failures: { state: true },
    renaming: { state: true },
  };

  static styles = styles;

  #projects = new StoreController(this, { store: $projects });
  #collapsed = new StoreController(this, { store: $collapsedProjects });
  #sessions = new StoreController(this, { store: $sessions });
  #activeSession = new StoreController(this, { store: $activeSessionId });
  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });
  /** @type {ContextMenuController<Project>} */
  #menu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-session-column__menu'),
    onSelect: (value, project) => this.#onMenuSelect(value, project),
  });
  /** @type {ContextMenuController<Session>} */
  #sessionMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-session-column__session-menu'),
    onSelect: (value, session) => this.#onSessionMenuSelect(value, session),
  });

  constructor() {
    super();
    /** @type {string | null} Shown as `~` in project paths. */
    this.home = null;
    /** @type {Record<string, string>} Why a project's folder couldn't be opened, by project id. */
    this.failures = {};
    /** @type {string | null} The session whose title is being edited in its row. */
    this.renaming = null;
  }

  connectedCallback() {
    super.connectedCallback();
    getHomeDir()
      .then((home) => (this.home = home.replace(/[\\/]+$/, '')))
      .catch(() => {});
  }

  /** @param {string} path */
  #displayPath(path) {
    const home = this.home;
    return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
      ? `~${path.slice(home.length)}`
      : path;
  }

  /**
   * Opens the project with an empty draft session in the chat.
   * @param {string} projectId
   */
  #newSession(projectId) {
    sessionController.create(projectId);
    toggleProject(projectId, true);
    this.#activate(projectId);
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
    else if (!this.#menu.onKeydown(project, e)) return;
    e.preventDefault();
  }

  /**
   * @param {string} value The chosen item's.
   * @param {Project} project The project the menu was opened on.
   */
  #onMenuSelect(value, project) {
    if (value === 'new-session') this.#newSession(project.id);
    else if (value === 'reveal')
      projectController.reveal(project.path).catch((err) => reportError('Revealing folder failed', err));
    else if (value === 'remove') this.#remove(project);
  }

  /**
   * Asks first; the folder on disk stays either way.
   * @param {Project} project
   */
  async #remove(project) {
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('acp-confirm-dialog')
    );
    const confirmed = await dialog.confirm({
      headline: 'Remove project?',
      message: `${project.name} will be removed from Brama.`,
      detail: 'The folder on disk stays.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    projectController.remove(project.id);
    this.#clearFailure(project.id);
  }

  /** @param {string} id */
  #clearFailure(id) {
    if (!(id in this.failures)) return;
    const { [id]: _cleared, ...rest } = this.failures;
    this.failures = rest;
  }

  /**
   * Shows a project's workspace (tree, tabs) once its folder is scanned and watched.
   * @param {string} id
   */
  async #activate(id) {
    try {
      await projectController.activate(id);
      this.#clearFailure(id);
    } catch (err) {
      reportError('Opening project failed', err);
      this.failures = { ...this.failures, [id]: String(err) };
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
    projectController.open().catch((err) => reportError('Opening folder failed', err));
  }

  /** @param {Session} session */
  #select(session) {
    this.#activate(session.projectId);
    sessionController.select(session.id);
  }

  /** @param {Event} e */
  #onSessionKeydown(e) {
    const key = /** @type {KeyboardEvent} */ (e).key;
    if (key !== 'Enter' && key !== ' ') return;
    e.preventDefault();
    /** @type {HTMLElement} */ (e.currentTarget).click();
  }

  /**
   * @param {string} value
   * @param {Session} session
   */
  #onSessionMenuSelect(value, session) {
    if (value === 'rename') this.#startRename(session);
    else if (value === 'log') sessionController.openLog(session.id);
    else if (value === 'stop') sessionController.stop(session.id);
    else if (value === 'remove') this.#removeSession(session);
  }

  /**
   * Swaps the row's title for a text field, focused with its text selected.
   * @param {Session} session
   */
  async #startRename(session) {
    this.renaming = session.id;
    await this.updateComplete;
    // After the closing menu has given focus back.
    requestAnimationFrame(() => {
      const input = /** @type {HTMLInputElement | null} */ (
        this.renderRoot.querySelector('.acp-session-column__rename')
      );
      input?.focus();
      input?.select();
    });
  }

  /**
   * Enter or leaving the field saves the title, Escape keeps the old one.
   * @param {Session} session
   * @param {HTMLInputElement} input
   * @param {boolean} save
   */
  #endRename(session, input, save) {
    if (this.renaming !== session.id) return;
    this.renaming = null;
    if (save) sessionController.rename(session.id, input.value);
  }

  /**
   * @param {Session} session
   * @param {KeyboardEvent} e
   */
  #onRenameKeydown(session, e) {
    e.stopPropagation();
    const input = /** @type {HTMLInputElement} */ (e.currentTarget);
    if (e.key === 'Enter') this.#endRename(session, input, true);
    else if (e.key === 'Escape') this.#endRename(session, input, false);
    else return;
    e.preventDefault();
    /** @type {HTMLElement | null} */ (input.closest('.acp-session-column__session'))?.focus();
  }

  /**
   * Asks first; the project's files stay either way.
   * @param {Session} session
   */
  async #removeSession(session) {
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (
      this.renderRoot.querySelector('acp-confirm-dialog')
    );
    const confirmed = await dialog.confirm(removeSessionConfirm(session));
    if (confirmed) await sessionController.remove(session.id);
  }

  /**
   * @param {Project} project
   * @param {Session[]} sessions Of this project.
   */
  #renderProject(project, sessions) {
    const expanded = !this.#collapsed.value.includes(project.id);
    const failure = this.failures[project.id];
    return html`
      <div
        class=${classMap({
          'acp-session-column__project': true,
          'acp-session-column__project_menu-open': this.#menu.target?.id === project.id,
          'acp-session-column__project_loading': this.#openingPath.value === project.id,
        })}
        role="treeitem"
        tabindex="0"
        aria-expanded=${expanded ? 'true' : 'false'}
        title=${project.path}
        @click=${() => this.#onProjectClick(project)}
        @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onProjectKeydown(project, e)}
        @contextmenu=${(/** @type {MouseEvent} */ e) => this.#menu.onContextMenu(project, e)}
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
      ${failure !== undefined
        ? html`<div class="acp-session-column__error" role="alert">Couldn't open the folder: ${failure}</div>`
        : nothing}
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
      @keydown=${(/** @type {KeyboardEvent} */ e) => {
        if (!this.#sessionMenu.onKeydown(session, e)) this.#onSessionKeydown(e);
      }}
      @contextmenu=${(/** @type {MouseEvent} */ e) => this.#sessionMenu.onContextMenu(session, e)}
    >
      <span
        class="acp-session-column__status acp-session-column__status_${session.status}"
        role="img"
        aria-label=${session.status}
      ></span>
      ${this.renaming === session.id
        ? html`<input
            class="acp-session-column__rename"
            aria-label="Session title"
            .value=${session.title}
            @click=${(/** @type {Event} */ e) => e.stopPropagation()}
            @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onRenameKeydown(session, e)}
            @blur=${(/** @type {FocusEvent} */ e) =>
              this.#endRename(session, /** @type {HTMLInputElement} */ (e.currentTarget), true)}
          />`
        : html`<span class="acp-session-column__session-title">${session.title}</span>`}
      ${session.branch
        ? html`<md-icon class="acp-session-column__branch-icon" title=${`Worktree on ${session.branch}`} aria-label="Worktree"
            >${unsafeSVG(branchIcon)}</md-icon
          >`
        : nothing}
      <span class="acp-session-column__session-age">${age(session.createdAt)}</span>
    </div>`;
  }

  #renderMenu() {
    return html`<md-menu
      class="acp-session-column__menu"
      aria-label=${this.#menu.target?.name ?? 'Project'}
      @select=${this.#menu.onSelect}
      @closed=${this.#menu.onClosed}
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

  #renderSessionMenu() {
    const session = this.#sessionMenu.target;
    return html`<md-menu
      class="acp-session-column__session-menu"
      aria-label=${session?.title ?? 'Session'}
      @select=${this.#sessionMenu.onSelect}
      @closed=${this.#sessionMenu.onClosed}
    >
      <md-menu-item class="acp-session-column__menu-item" value="rename">Rename</md-menu-item>
      <md-menu-item class="acp-session-column__menu-item" value="log">Open agent log</md-menu-item>
      ${session && RUNNING.has(session.status)
        ? html`<md-menu-item class="acp-session-column__menu-item" value="stop">Stop agent</md-menu-item>`
        : nothing}
      <md-hr></md-hr>
      <md-menu-item class="acp-session-column__menu-item" value="remove">Remove session</md-menu-item>
    </md-menu>`;
  }

  render() {
    const projects = this.#projects.value;
    const sessions = this.#sessions.value;
    return html`
      <h2 class="acp-session-column__title">Projects</h2>
      <md-fab class="acp-session-column__new" variant="primary" size="s" label="New" @click=${this.#openProject}>
        <md-icon slot="icon">${unsafeSVG(addIcon)}</md-icon>
      </md-fab>
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
      ${this.#renderMenu()} ${this.#renderSessionMenu()}
      <acp-confirm-dialog></acp-confirm-dialog>
    `;
  }
}

customElements.define('acp-session-column', AcpSessionColumn);
