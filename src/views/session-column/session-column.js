import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { html } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/session-list/session-list.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { SessionActionsController } from '../../controllers/session-actions/SessionActionsController.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $collapsedProjects, $projects, toggleProject } from '../../stores/projects/projects.js';
import { $permissionRequests } from '../../stores/session-runtime/session-runtime.js';
import { $unreadSessions, markProjectRead, markRead, markUnread } from '../../stores/session-read/session-read.js';
import { $now } from '../../stores/clock/clock.js';
import { $sessionSync } from '../../stores/session-sync/session-sync.js';
import { $activeSessionId, $pinnedSessions, $sessions, $sessionsLoaded } from '../../stores/sessions/sessions.js';
import { $openingPath, $workspace } from '../../stores/workspace/workspace.js';

/**
 * @tag acp-session-column
 * @summary The session list's container: projects and their sessions from the stores, the active project's sync, and what the list asks for (open, select, start, rename, reveal, remove, mark read or unread, resync).
 */
export class AcpSessionColumn extends ViewElement {
  static properties = {
    home: { state: true },
    failures: { state: true },
  };

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
    projects.homeDir()
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
      await projects.activate(id);
      this.#clearFailure(id);
    } catch (err) {
      app.reportError('Opening project failed', err);
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
    projects.open().catch((err) => app.reportError('Opening folder failed', err));
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
    sessions.create(id);
    toggleProject(id, true);
    this.#activate(id);
  }

  /** @param {Event} e */
  #onProjectReveal(e) {
    projects.reveal(this.#projectIdOf(e)).catch((err) => app.reportError('Revealing folder failed', err));
  }

  /**
   * Asks first; the folder on disk stays either way.
   * @param {Event} e
   */
  async #onProjectRemove(e) {
    const id = this.#projectIdOf(e);
    const dialog = this.#dialog;
    if (dialog && (await projects.confirmRemove(id, dialog))) this.#clearFailure(id);
  }

  /** @param {Event} e */
  #onSessionSelect(e) {
    const { sessionId } = /** @type {CustomEvent<{ sessionId: string }>} */ (e).detail;
    const session = this.#sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    this.#activate(session.projectId);
    sessions.select(session.id);
  }

  /** @param {Event} e */
  #onSessionMarkRead(e) {
    const { sessionId, read } = /** @type {CustomEvent<{ sessionId: string, read: boolean }>} */ (e).detail;
    if (read) markRead(sessionId);
    else markUnread(sessionId);
  }

  /** @param {Event} e */
  #onProjectMarkRead(e) {
    markProjectRead(this.#projectIdOf(e));
  }

  #onResync() {
    const path = this.#workspace.value?.path;
    if (path) sessions.sync(path, { force: true });
  }

  render() {
    const path = this.#workspace.value?.path ?? null;
    return html`<acp-panel>
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
        .loading=${sessions.loadingProjects(
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
        @acp-project-mark-read=${this.#onProjectMarkRead}
        @acp-session-select=${this.#onSessionSelect}
        @acp-session-mark-read=${this.#onSessionMarkRead}
        @acp-session-resync=${this.#onResync}
      ></acp-session-list>
      <acp-confirm-dialog></acp-confirm-dialog>
    </acp-panel>`;
  }
}

customElements.define('acp-session-column', AcpSessionColumn);
