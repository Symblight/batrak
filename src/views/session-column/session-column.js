import { html } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/session-list/session-list.js';
import '../../components/session-sync/session-sync.js';
import '../../components/workspace-delete-dialog/workspace-delete-dialog.js';
import '../../components/workspace-header/workspace-header.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { SessionActionsController } from '../../controllers/session-actions/SessionActionsController.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { $permissionRequests } from '../../stores/session-runtime/session-runtime.js';
import { $unreadSessions, markRead, markUnread } from '../../stores/session-read/session-read.js';
import { $now } from '../../stores/clock/clock.js';
import { $sessionSync } from '../../stores/session-sync/session-sync.js';
import { $activeSessionId, $pinnedSessions, $sessions, $sessionsLoaded, workspaceOfSession } from '../../stores/sessions/sessions.js';
import { $projectPath } from '../../stores/project/project.js';
import { $activeWorkspace, $activeWorkspaceId, MAIN } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('../../hooks/workspaces/types.js').Workspace} Workspace */

/**
 * @tag acp-session-column
 * @summary The Sessions column's container: the shown workspace's header (name, New chat, the sync, its banners) and its chats from the stores, and what they ask for (select, new chat, rename, reveal, remove, mark read or unread, resync, recreate or delete the workspace).
 */
export class AcpSessionColumn extends ViewElement {
  #sessions = new StoreController(this, { store: $sessions });
  #activeSession = new StoreController(this, { store: $activeSessionId });
  #projectPath = new StoreController(this, { store: $projectPath });
  #workspaceId = new StoreController(this, { store: $activeWorkspaceId });
  #workspace = new StoreController(this, { store: $activeWorkspace });
  #pinned = new StoreController(this, { store: $pinnedSessions });
  #unread = new StoreController(this, { store: $unreadSessions });
  #permissions = new StoreController(this, { store: $permissionRequests });
  #sync = new StoreController(this, { store: $sessionSync });
  #loaded = new StoreController(this, { store: $sessionsLoaded });
  #now = new StoreController(this, { store: $now });
  /** The list's rename, reveal and delete. */
  #sessionActions = new SessionActionsController(this, { confirm: () => this.renderRoot.querySelector('acp-confirm-dialog') });

  /** The shown workspace's header: its record, or a stand-in for a draft workspace (none: Main). */
  get #headerWorkspace() {
    const id = this.#workspaceId.value;
    if (id === MAIN) return null;
    return this.#workspace.value ?? /** @type {Workspace} */ (/** @type {unknown} */ ({ id, name: 'New workspace', creating: false, missing: false, error: null }));
  }

  #onNewChat = () => {
    const path = this.#projectPath.value;
    if (path !== null) sessions.create(path, this.#workspaceId.value);
  };

  /** @param {Event} e */
  #onSessionSelect(e) {
    sessions.select(/** @type {CustomEvent<{ sessionId: string }>} */ (e).detail.sessionId);
  }

  /** @param {Event} e */
  #onSessionMarkRead(e) {
    const { sessionId, read } = /** @type {CustomEvent<{ sessionId: string, read: boolean }>} */ (e).detail;
    if (read) markRead(sessionId);
    else markUnread(sessionId);
  }

  #onResync = () => {
    const path = this.#projectPath.value;
    if (path) sessions.sync(path, { force: true });
  };

  /** @param {Event} e */
  #onRecreate(e) {
    void workspaces.recreate(/** @type {CustomEvent<{ id: string }>} */ (e).detail.id);
  }

  /** @param {Event} e */
  #onDeleteRequest(e) {
    void workspaces.confirmDelete(/** @type {CustomEvent<{ id: string }>} */ (e).detail.id, this.renderRoot.querySelector('acp-workspace-delete-dialog'));
  }

  /** @param {Event} e */
  #onDelete(e) {
    const { id, keepBranch } = /** @type {CustomEvent<{ id: string, keepBranch: boolean }>} */ (e).detail;
    void workspaces.delete(id, keepBranch);
  }

  render() {
    const path = this.#projectPath.value;
    const workspaceId = this.#workspaceId.value;
    const chats = this.#sessions.value.filter((s) => s.projectId === path && workspaceOfSession(s) === workspaceId);
    const loading = path !== null && sessions.loadingProjects([path], this.#loaded.value, this.#sync.value).includes(path);
    return html`<acp-panel>
      <acp-workspace-header
        slot="header"
        .workspace=${this.#headerWorkspace}
        @acp-workspace-new-chat=${this.#onNewChat}
        @acp-workspace-recreate=${this.#onRecreate}
        @acp-workspace-delete-request=${this.#onDeleteRequest}
        @acp-session-resync=${this.#onResync}
      >
        <acp-session-sync .sync=${path === null ? null : (this.#sync.value[path] ?? { running: false, report: null })}></acp-session-sync>
      </acp-workspace-header>
      <acp-session-list
        class="acp-session-column__list"
        .sessions=${chats}
        .activeSessionId=${this.#activeSession.value}
        .pinned=${this.#pinned.value}
        .unread=${this.#unread.value}
        .waiting=${Object.keys(this.#permissions.value)}
        .loading=${loading}
        .now=${this.#now.value}
        @acp-session-select=${this.#onSessionSelect}
        @acp-session-mark-read=${this.#onSessionMarkRead}
      ></acp-session-list>
      <acp-confirm-dialog></acp-confirm-dialog>
      <acp-workspace-delete-dialog @acp-workspace-delete=${this.#onDelete}></acp-workspace-delete-dialog>
    </acp-panel>`;
  }
}

customElements.define('acp-session-column', AcpSessionColumn);
