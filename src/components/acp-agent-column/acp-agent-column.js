import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/progress-circular';
import '../acp-chat/acp-chat.js';
import '../acp-confirm-dialog/acp-confirm-dialog.js';
import '../acp-session-header/acp-session-header.js';
import '../acp-welcome/acp-welcome.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ChatSessionController } from '../../controllers/chat-session/ChatSessionController.js';
import { ChatPartsController } from '../../controllers/chat-parts/ChatPartsController.js';
import { SessionActionsController } from '../../controllers/session-actions/SessionActionsController.js';
import { sessionIndicator } from '../../models/sessions.js';
import { USER_ID, acpAdapter } from '../../services/acp-adapter.js';
import { agentConfig } from '../../services/agent-config.js';
import { gitBranches, openUrl, quickOpen } from '../../services/ipc.js';
import { reportError } from '../../services/notices.js';
import { terminalController } from '../../services/terminals.js';
import { projectController } from '../../services/project-controller.js';
import { sessionController } from '../../services/session-controller.js';
import { $signIns, signInOf } from '../../stores/agents.js';
import { $chatInserts, takeChatInserts } from '../../stores/chat.js';
import { $agents, $composer, agentInfo, selectAgent, setRunTarget } from '../../stores/composer.js';
import { $activeContextUsage } from '../../stores/context-usage.js';
import { openAgents } from '../../stores/editor.js';
import { $gitRepo } from '../../stores/git.js';
import { $activeFolder, $activeSession, $activeSessionId, $localShared } from '../../stores/sessions.js';
import { $activeNotice, $activePermission, $sessionNotices } from '../../stores/session-runtime.js';
import { $terminals, openLoginTerminal } from '../../stores/terminals.js';
import { $openingPath, $rootId, $workspace, $workspaceSettings } from '../../stores/workspace.js';
import styles from './acp-agent-column.css?inline';

/** @typedef {import('../../models/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../models/types.js').RunTarget} RunTarget */
/** @typedef {import('../acp-session-banner/acp-session-banner.js').SessionAction} SessionAction */

/**
 * @tag acp-agent-column
 * @summary Agent chat for the opened project; the welcome screen until one is opened, a spinner while one opens.
 * @fires acp-file-open `{ path, line }` when a file chip or link in a message, or a tool call's location, is clicked
 * @fires acp-file-reveal `{ path }` when a folder chip or link in a message is clicked
 */
export class AcpAgentColumn extends LitElement {
  static properties = {
    fileOptions: { state: true },
    branches: { state: true },
  };

  static styles = styles;

  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });
  #composer = new StoreController(this, { store: $composer });
  #contextUsage = new StoreController(this, { store: $activeContextUsage });
  #agents = new StoreController(this, { store: $agents });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #rootId = new StoreController(this, { store: $rootId });
  #activeFolder = new StoreController(this, { store: $activeFolder });
  #permission = new StoreController(this, { store: $activePermission });
  #notice = new StoreController(this, { store: $activeNotice });
  /** Re-renders on a sign-in's change; `#signInRun()` reads it. */
  #signIns = new StoreController(this, { store: $signIns });
  /** Whether a login's terminal is this window's; `#loginHere()` reads it. */
  #terminals = new StoreController(this, { store: $terminals });
  #activeSessionId = new StoreController(this, { store: $activeSessionId });
  #activeSession = new StoreController(this, { store: $activeSession });
  #localShared = new StoreController(this, { store: $localShared });
  #workspaceSettings = new StoreController(this, { store: $workspaceSettings });
  /** The header's rename, reset title, reveal and delete. */
  #sessionActions = new SessionActionsController(this, {
    confirm: () => this.renderRoot.querySelector('acp-confirm-dialog'),
  });

  /** @type {ChatSessionController} */
  #session = new ChatSessionController(this, { chat: () => this.#chat?.chat ?? null });
  /** @type {ChatPartsController} */
  #parts = new ChatPartsController(this, { attachments: () => /** @type {AcpChat} */ (this.#chat).attachments });

  /** Code sent from the editors (selections, `<acp-comment-bar>`'s comments) goes into the composer. */
  #chatInserts = new StoreController(this, {
    store: $chatInserts,
    onChange: (inserts) => {
      if (inserts.length) this.#insertCode();
    },
  });

  /** Sequence of `@` queries; only the latest answer is shown. */
  #fileQueryId = 0;

  constructor() {
    super();
    /** @type {QuickOpenItem[]} */
    this.fileOptions = [];
    /** @type {{ rootId: string, names: string[] } | null} The run target's branches, of the root they're from. */
    this.branches = null;
  }

  /** @returns {AcpChat | null} */
  get #chat() {
    return this.renderRoot?.querySelector('acp-chat') ?? null;
  }

  /** Done once the chat has rendered what this update gave it too (`ChatSessionController` reads it). */
  async getUpdateComplete() {
    const result = await super.getUpdateComplete();
    await this.#chat?.updateComplete;
    return result;
  }

  /** Takes `$chatInserts` into the composer once it is up; until then they wait in the store. */
  async #insertCode() {
    await this.updateComplete;
    const chat = this.#chat;
    if (!chat || !(await chat.composerReady())) return;
    chat.insertCode(takeChatInserts());
  }

  /** @param {Event} e */
  async #onFileQuery(e) {
    const { query } = /** @type {CustomEvent<{ query: string | null }>} */ (e).detail;
    const id = ++this.#fileQueryId;
    const rootId = projectController.rootId;
    if (query === null) return;
    if (rootId === null) {
      this.fileOptions = [];
      return;
    }
    try {
      const { items, cancelled } = await quickOpen(rootId, query, true);
      if (id !== this.#fileQueryId || cancelled) return;
      this.fileOptions = items;
    } catch (err) {
      reportError('File search failed', err);
    }
  }

  async #onBranchesQuery() {
    const rootId = $rootId.get();
    if (rootId === null) return;
    try {
      const names = await gitBranches(rootId);
      if (rootId === $rootId.get()) this.branches = { rootId, names };
    } catch (err) {
      reportError('Listing branches failed', err);
    }
  }

  /** @param {Event} e */
  #onPermissionRespond(e) {
    const { requestId, optionId } = /** @type {CustomEvent<{ requestId: string, optionId: string }>} */ (e).detail;
    const id = $activeSessionId.get();
    if (id !== null) sessionController.respondPermission(id, requestId, optionId);
  }

  /** @param {Event} e */
  #onSessionAction(e) {
    const { action } = /** @type {CustomEvent<{ action: SessionAction }>} */ (e).detail;
    const id = $activeSessionId.get();
    if (id === null) return;
    if (action === 'open-log') sessionController.openLog(id);
    else if (action === 'open-terminal') terminalController.sessionTerminal(id);
    else if (action === 'show-login') {
      const terminal = this.#signInRun()?.terminal;
      if (terminal && this.#loginHere()) openLoginTerminal(terminal, $workspace.get()?.path ?? null);
    }
    else if (action === 'restart') sessionController.restart(id);
    else if (action === 'turn-on-agent') {
      const agentId = $sessionNotices.get()[id]?.offAgent;
      if (agentId) agentConfig.setEnabled(agentId, true);
    }
    else sessionController.dismissNotice(id);
  }

  /** @param {Event} e */
  #onSignIn(e) {
    const { agentId, methodId } = /** @type {CustomEvent<{ agentId: string, methodId: string | null }>} */ (e).detail;
    agentConfig.signIn(agentId, methodId);
  }

  /** @param {Event} e */
  #onSignInCancel(e) {
    agentConfig.cancelSignIn(/** @type {CustomEvent<{ agentId: string }>} */ (e).detail.agentId);
  }

  /** The sign-in running or failed for the active notice's agent. */
  #signInRun() {
    const agentId = this.#notice.value?.signIn?.agentId;
    return agentId ? signInOf($workspace.get()?.path ?? null, agentId) : null;
  }

  /** Whether the active notice's sign-in runs its login in this window's terminal. */
  #loginHere() {
    const terminal = this.#signInRun()?.terminal;
    return terminal !== undefined && terminal !== null && this.#terminals.value[terminal.terminalId] !== undefined;
  }

  /** The session a queued turn waits for, from the banner. */
  #onSessionSelect = (/** @type {Event} */ e) => {
    sessionController.select(/** @type {CustomEvent<{ sessionId: string }>} */ (e).detail.sessionId);
  };

  /** @param {Event} e */
  #onAgentSelect(e) {
    selectAgent(/** @type {CustomEvent<{ agentId: string }>} */ (e).detail.agentId);
  }

  /** A model, level or mode; a model or level of another agent switches to that agent first. */
  #onConfigOption = (/** @type {Event} */ e) => {
    const { agentId, configId, value } = /** @type {CustomEvent<{ agentId?: string, configId: string, value: string }>} */ (
      e
    ).detail;
    if (agentId) selectAgent(agentId);
    const id = $activeSessionId.get();
    if (id !== null) sessionController.setConfigOption(id, configId, value);
  };

  /** @param {Event} e */
  #onRunTargetChange(e) {
    setRunTarget(/** @type {CustomEvent<{ patch: Partial<RunTarget> }>} */ (e).detail.patch);
  }

  /** @param {Event} e */
  #onLinkOpen(e) {
    const { url } = /** @type {CustomEvent<{ url: string }>} */ (e).detail;
    openUrl(url).catch((err) => reportError('Opening the link failed', err));
  }

  #onNewSession() {
    const workspace = $workspace.get();
    if (workspace) sessionController.create(workspace.path);
  }

  /** The active session's header; a draft shows as a new session. */
  #renderHeader() {
    if (this.#activeSessionId.value === null) return nothing;
    const session = this.#activeSession.value;
    return html`<acp-session-header
      class="acp-agent-column__header"
      session-id=${session?.id ?? ''}
      session-title=${session?.title ?? ''}
      ?draft=${session === null}
      ?provisional=${session?.titleSource === 'prompt'}
      ?resettable=${session?.titleSource === 'user' && session.agentTitle !== null}
      .indicator=${session ? sessionIndicator(session.status, this.#permission.value !== null) : null}
      @acp-session-new=${this.#onNewSession}
    ></acp-session-header>`;
  }

  #onOpenLocal() {
    projectController.open().catch((err) => reportError('Opening folder failed', err));
  }

  render() {
    const opening = this.#openingPath.value !== null;
    const workspace = this.#workspace.value;
    const composer = this.#composer.value;
    const hasSession = this.#activeSessionId.value !== null;
    // Hidden rather than removed while a project opens, so the chat keeps its state.
    return html`
      ${workspace !== null && !opening ? this.#renderHeader() : nothing}
      ${workspace !== null
        ? html`<acp-chat
            class="acp-agent-column__chat"
            ?hidden=${opening}
            .conversationId=${this.#session.conversationId}
            ?empty=${this.#session.empty}
            .adapter=${acpAdapter}
            .userId=${USER_ID}
            .partElements=${this.#parts.partElements}
            .root=${this.#activeFolder.value ?? workspace.path}
            .fileOptions=${this.fileOptions}
            .composer=${composer}
            .usage=${this.#contextUsage.value}
            .agents=${this.#agents.value}
            .agent=${agentInfo(composer.agentId, this.#activeSession.value?.agentName ?? null)}
            .branches=${this.branches?.rootId === this.#rootId.value ? this.branches.names : []}
            .currentBranch=${this.#gitRepo.value.repo?.branch ?? null}
            .localShared=${this.#localShared.value}
            .localTurns=${this.#workspaceSettings.value.localTurns}
            .permission=${hasSession ? this.#permission.value : null}
            .notice=${hasSession ? this.#notice.value : null}
            .signInRun=${hasSession ? this.#signInRun() : null}
            .loginHere=${hasSession && this.#loginHere()}
            @acp-chat-file-query=${this.#onFileQuery}
            @acp-permission-respond=${this.#onPermissionRespond}
            @acp-session-action=${this.#onSessionAction}
            @acp-session-select=${this.#onSessionSelect}
            @acp-agent-sign-in=${this.#onSignIn}
            @acp-agent-sign-in-cancel=${this.#onSignInCancel}
            @acp-agent-add-open=${() => openAgents({ add: true })}
            @acp-agents-manage=${() => openAgents()}
            @acp-agent-select=${this.#onAgentSelect}
            @acp-config-option=${this.#onConfigOption}
            @acp-run-target-change=${this.#onRunTargetChange}
            @acp-branches-query=${this.#onBranchesQuery}
            @acp-link-open=${this.#onLinkOpen}
          ></acp-chat>`
        : html`<acp-welcome
            class="acp-agent-column__welcome"
            ?hidden=${opening}
            @acp-open-local=${this.#onOpenLocal}
          ></acp-welcome>`}
      ${opening
        ? html`<div class="acp-agent-column__loading">
            <md-progress-circular class="acp-agent-column__spinner" aria-label="Opening project"></md-progress-circular>
          </div>`
        : nothing}
      <acp-confirm-dialog></acp-confirm-dialog>
    `;
  }
}

/** @typedef {import('../acp-chat/acp-chat.js').AcpChat} AcpChat */

customElements.define('acp-agent-column', AcpAgentColumn);
