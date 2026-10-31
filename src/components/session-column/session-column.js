import { LitElement, html } from 'lit';
import '../confirm-dialog/confirm-dialog.js';
import '../session-list/session-list.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { SessionActionsController } from '../../controllers/session-actions/SessionActionsController.js';
import { getHomeDir } from '../../services/ipc/ipc.js';
import { reportError } from '../../services/notices/notices.js';
import { projectController } from '../../services/project-controller/project-controller.js';
import { sessionController } from '../../services/session-controller/session-controller.js';
import { $collapsedProjects, $projects, toggleProject } from '../../stores/projects/projects.js';
import { $permissionRequests, $unreadSessions } from '../../stores/session-runtime/session-runtime.js';
import { $now } from '../../stores/clock/clock.js';
import { $sessionSync } from '../../stores/session-sync/session-sync.js';
import { loadingProjects } from '../../models/sessions/sessions.js';
import { $activeSessionId, $pinnedSessions, $sessions, $sessionsLoaded } from '../../stores/sessions/sessions.js';
import { $openingPath, $workspace } from '../../stores/workspace/workspace.js';
import styles from './session-column.css?inline';

/**
 * @tag acp-session-column
 * @summary The session list's container: projects and their sessions from the stores, the active project's sync, and what the list asks for (open, select, start, rename, reveal, remove, resync).
 */
export class AcpSessionColumn extends LitElement {
  static properties = {
    home: { state: true },
    failures: { state: true },
  };

  static styles = styles;

  #projects = new StoreController(this, { store: $projects });
  #collapsed = new StoreController(this, { store: $collapsedProjects });
  #sessions = new StoreController(this, { store: $sessions });
  #activeSession = new StoreController(this, { store: $activeSessionId });
  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });
  #pinned = new StoreController(this, { store: $pinnedSessions });
  #unread = new StoreController(this, { store: $unreadSessions });
  #permissions = new StoreController(this, { store: $permissionRequests });
  #sync = new StoreController(this, { store: $sessionSync });
  #loaded = new StoreController(this, { store: $sessionsLoaded });
  #now = new StoreController(this, { store: $now });
  /** The list's rename, reveal and delete. */
  #sessionActions = new SessionActionsController(this, { confirm: () => this.#dialog });

  constructor() {
    super();
    /** @type {string | null} Shown as `~` in project paths. */
    this.home = null;
    /** @type {Record<string, string>} Why a project's folder couldn't be opened, by project id. */
    this.failures = {};
  }

  connectedCallback() {
    super.connectedCallback();
    getHomeDir()
      .then((home) => (this.home = home.replace(/[\\/]+$/, '')))
      .catch(() => {});
  }

  /** @returns {HTMLElementTagNameMap['acp-confirm-dialog'] | null} */
  get #dialog() {
    return this.renderRoot.querySelector('acp-confirm-dialog');
  }

  /** @param {Event} e */
  #projectIdOf(e) {
    return /** @type {CustomEvent<{ projectId: string }>} */ (e).detail.projectId;
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

  /** @param {string} id */
  #clearFailure(id) {
    if (!(id in this.failures)) return;
    const { [id]: _cleared, ...rest } = this.failures;
    this.failures = rest;
  }

  #onOpenFolder() {
    projectController.open().catch((err) => reportError('Opening folder failed', err));
  }

  /**
   * A click on an inactive project switches to it and expands it; on the active one it toggles.
   * @param {Event} e
   */
  #onProjectSelect(e) {
    const id = this.#projectIdOf(e);
    if (id === this.#workspace.value?.path) {
      toggleProject(id);
      return;
    }
    toggleProject(id, true);
    this.#activate(id);
  }

  /** @param {Event} e */
  #onProjectToggle(e) {
    const { projectId, expanded } = /** @type {CustomEvent<{ projectId: string, expanded: boolean }>} */ (e).detail;
    toggleProject(projectId, expanded);
  }

  /**
   * Opens the project with an empty draft session in the chat.
   * @param {Event} e
   */
  #onNewSession(e) {
    const id = this.#projectIdOf(e);
    sessionController.create(id);
    toggleProject(id, true);
    this.#activate(id);
  }

  /** @param {Event} e */
  #onProjectReveal(e) {
    projectController.reveal(this.#projectIdOf(e)).catch((err) => reportError('Revealing folder failed', err));
  }

  /**
   * Asks first; the folder on disk stays either way.
   * @param {Event} e
   */
  async #onProjectRemove(e) {
    const project = this.#projects.value.find((p) => p.id === this.#projectIdOf(e));
    const dialog = this.#dialog;
    if (!project || !dialog) return;
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

  /** @param {Event} e */
  #onSessionSelect(e) {
    const { sessionId } = /** @type {CustomEvent<{ sessionId: string }>} */ (e).detail;
    const session = this.#sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    this.#activate(session.projectId);
    sessionController.select(session.id);
  }

  #onResync() {
    const path = this.#workspace.value?.path;
    if (path) sessionController.sync(path, { force: true });
  }

  render() {
    const path = this.#workspace.value?.path ?? null;
    return html`
      <acp-session-list
        class="acp-session-column__list"
        .projects=${this.#projects.value}
        .sessions=${this.#sessions.value}
        .collapsed=${this.#collapsed.value}
        .activeProjectId=${this.#workspace.value?.path ?? null}
        .activeSessionId=${this.#activeSession.value}
        .openingProjectId=${this.#openingPath.value}
        .pinned=${this.#pinned.value}
        .unread=${this.#unread.value}
        .waiting=${Object.keys(this.#permissions.value)}
        .failures=${this.failures}
        .loading=${loadingProjects(
          this.#projects.value.map((p) => p.id),
          this.#loaded.value,
          this.#sync.value,
        )}
        .now=${this.#now.value}
        .sync=${path === null ? null : (this.#sync.value[path] ?? { running: false, report: null })}
        .home=${this.home}
        @acp-project-open-folder=${this.#onOpenFolder}
        @acp-project-select=${this.#onProjectSelect}
        @acp-project-toggle=${this.#onProjectToggle}
        @acp-project-new-session=${this.#onNewSession}
        @acp-project-reveal=${this.#onProjectReveal}
        @acp-project-remove=${this.#onProjectRemove}
        @acp-session-select=${this.#onSessionSelect}
        @acp-session-resync=${this.#onResync}
      ></acp-session-list>
      <acp-confirm-dialog></acp-confirm-dialog>
    `;
  }
}

customElements.define('acp-session-column', AcpSessionColumn);
