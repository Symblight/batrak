import { git } from '../../hooks/git/git.js';
import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { html } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/chat/chat.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ChatSessionController } from '../../controllers/chat-session/ChatSessionController.js';
import { ChatPartsController } from '../../controllers/chat-parts/ChatPartsController.js';
import { agents } from '../../hooks/agents/agents.js';
import { search } from '../../hooks/search/search.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $signIns, signInOf } from '../../stores/agents/agents.js';
import { $agents, $composer, $composerOptionsStatus, agentInfo, selectAgent, setRunTarget } from '../../stores/composer/composer.js';
import { $activeContextUsage } from '../../stores/context-usage/context-usage.js';
import { openAgents } from '../../stores/editor/editor.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $activeFolder, $activeSession, $activeSessionId, $localShared } from '../../stores/sessions/sessions.js';
import { $activeNotice, $activePermission, $sessionNotices } from '../../stores/session-runtime/session-runtime.js';
import { $terminals, openLoginTerminal } from '../../stores/terminals/terminals.js';
import { $project, $projectSettings } from '../../stores/project/project.js';
import { $rootId } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../hooks/composer/types.js').RunTarget} RunTarget */
/** @typedef {import('../../components/session-banner/session-banner.js').SessionAction} SessionAction */
/** @typedef {import('../../components/chat/chat.js').AcpChat} AcpChat */

/**
 * @tag acp-chat-view
 * @summary The shown session's chat wired to its data: the conversation, the composer's agent, model and run target, the banner's permission, notice and sign-in, `@` file picks and branches.
 * @fires acp-file-open `{ path, line }` when a file chip or link in a message, or a tool call's location, is clicked
 * @fires acp-file-reveal `{ path }` when a folder chip or link in a message is clicked
 */
export class AcpChatView extends ViewElement {
  static properties = {
    concealed: { type: Boolean },
    dropping: { type: Boolean },
    fileOptions: { state: true },
    branches: { state: true },
  };

  #project = new StoreController(this, { store: $project });
  #composer = new StoreController(this, { store: $composer });
  #optionsStatus = new StoreController(this, { store: $composerOptionsStatus });
  #contextUsage = new StoreController(this, { store: $activeContextUsage });
  #agents = new StoreController(this, { store: $agents });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #rootId = new StoreController(this, { store: $rootId });
  #activeFolder = new StoreController(this, { store: $activeFolder });
  #activeSessionId = new StoreController(this, { store: $activeSessionId });
  #activeSession = new StoreController(this, { store: $activeSession });
  #permission = new StoreController(this, { store: $activePermission });
  #notice = new StoreController(this, { store: $activeNotice });
  #localShared = new StoreController(this, { store: $localShared });
  #projectSettings = new StoreController(this, { store: $projectSettings });
  /** Re-renders on a sign-in's change; `#signInRun()` reads it. */
  #signIns = new StoreController(this, { store: $signIns });
  /** Whether a login's terminal is this window's; `#loginHere()` reads it. */
  #terminals = new StoreController(this, { store: $terminals });

  /** @type {ChatSessionController} */
  #session = new ChatSessionController(this, { chat: () => this.chat?.chat ?? null });
  /** @type {ChatPartsController} */
  #parts = new ChatPartsController(this, { attachments: () => /** @type {AcpChat} */ (this.chat).attachments });

  /** Sequence of `@` queries; only the latest answer is shown. */
  #fileQueryId = 0;

  constructor() {
    super();
    /** @type {boolean} The chat stays rendered, so it keeps its state, but is not shown. */
    this.concealed = false;
    /** @type {boolean} Files from the OS are dragged over the chat. */
    this.dropping = false;
    /** @type {QuickOpenItem[]} */
    this.fileOptions = [];
    /** @type {{ rootId: string, names: string[] } | null} The run target's branches, of the root they're from. */
    this.branches = null;
  }

  /** @returns {AcpChat | null} */
  get chat() {
    return this.renderRoot?.querySelector('acp-chat') ?? null;
  }

  /** Done once the chat has rendered what this update gave it too (`ChatSessionController` reads it). */
  async getUpdateComplete() {
    const result = await super.getUpdateComplete();
    await this.chat?.updateComplete;
    return result;
  }

  /** @param {Event} e */
  async #onFileQuery(e) {
    const { query } = /** @type {CustomEvent<{ query: string | null }>} */ (e).detail;
    const id = ++this.#fileQueryId;
    const rootId = projects.rootId();
    if (query === null) return;
    if (rootId === null) {
      this.fileOptions = [];
      return;
    }
    try {
      const { items, cancelled } = await search.quickOpen(rootId, query, 'all');
      if (id !== this.#fileQueryId || cancelled) return;
      this.fileOptions = items;
    } catch (err) {
      app.reportError('File search failed', err);
    }
  }

  async #onBranchesQuery() {
    const rootId = $rootId.get();
    if (rootId === null) return;
    try {
      const names = await git.branches(rootId);
      if (rootId === $rootId.get()) this.branches = { rootId, names };
    } catch (err) {
      app.reportError('Listing branches failed', err);
    }
  }

  /** @param {Event} e */
  #onPermissionRespond(e) {
    const { requestId, optionId } = /** @type {CustomEvent<{ requestId: string, optionId: string }>} */ (e).detail;
    const id = $activeSessionId.get();
    if (id !== null) sessions.respondPermission(id, requestId, optionId);
  }

  /** @param {Event} e */
  #onSessionAction(e) {
    const { action } = /** @type {CustomEvent<{ action: SessionAction }>} */ (e).detail;
    const id = $activeSessionId.get();
    if (id === null) return;
    if (action === 'open-log') sessions.openLog(id);
    else if (action === 'open-terminal') sessions.openInTerminal(id);
    else if (action === 'show-login') {
      const terminal = this.#signInRun()?.terminal;
      if (terminal && this.#loginHere()) openLoginTerminal(terminal, $project.get()?.path ?? null);
    }
    else if (action === 'restart') sessions.restart(id);
    else if (action === 'turn-on-agent') {
      const agentId = $sessionNotices.get()[id]?.offAgent;
      if (agentId) agents.setEnabled(agentId, true);
    }
    else sessions.dismissNotice(id);
  }

  /** @param {Event} e */
  #onSignIn(e) {
    const { agentId, methodId } = /** @type {CustomEvent<{ agentId: string, methodId: string | null }>} */ (e).detail;
    agents.signIn(agentId, methodId);
  }

  /** @param {Event} e */
  #onSignInCancel(e) {
    agents.cancelSignIn(/** @type {CustomEvent<{ agentId: string }>} */ (e).detail.agentId);
  }

  /** The sign-in running or failed for the active notice's agent. */
  #signInRun() {
    const agentId = this.#notice.value?.signIn?.agentId;
    return agentId ? signInOf($project.get()?.path ?? null, agentId) : null;
  }

  /** Whether the active notice's sign-in runs its login in this window's terminal. */
  #loginHere() {
    const terminal = this.#signInRun()?.terminal;
    return terminal !== undefined && terminal !== null && this.#terminals.value[terminal.terminalId] !== undefined;
  }

  /** The session a queued turn waits for, from the banner. */
  #onSessionSelect = (/** @type {Event} */ e) => {
    sessions.select(/** @type {CustomEvent<{ sessionId: string }>} */ (e).detail.sessionId);
  };

  /** @param {Event} e */
  #onAgentSelect(e) {
    const { agentId } = /** @type {CustomEvent<{ agentId: string }>} */ (e).detail;
    selectAgent(agentId);
    // Its models load while the model picker waits (or shows the ones cached).
    agents.loadOptions(agentId);
  }

  /** A model, level, mode or permission option of the composer's agent. */
  #onConfigOption = (/** @type {Event} */ e) => {
    const { configId, value } = /** @type {CustomEvent<{ configId: string, value: string }>} */ (e).detail;
    const id = $activeSessionId.get();
    if (id !== null) sessions.setConfigOption(id, configId, value);
  };

  /** @param {Event} e */
  #onRunTargetChange(e) {
    setRunTarget(/** @type {CustomEvent<{ patch: Partial<RunTarget> }>} */ (e).detail.patch);
  }

  /** @param {Event} e */
  #onLinkOpen(e) {
    const { url } = /** @type {CustomEvent<{ url: string }>} */ (e).detail;
    app.openUrl(url).catch((err) => app.reportError('Opening the link failed', err));
  }

  render() {
    const project = this.#project.value;
    if (project === null) return html``;
    const composer = this.#composer.value;
    const hasSession = this.#activeSessionId.value !== null;
    return html`<acp-chat
      ?hidden=${this.concealed}
      .conversationId=${this.#session.conversationId}
      ?empty=${this.#session.empty}
      .adapter=${sessions.adapter}
      .userId=${sessions.USER_ID}
      .partElements=${this.#parts.partElements}
      .root=${this.#activeFolder.value ?? project.path}
      .fileOptions=${this.fileOptions}
      .composer=${composer}
      .optionsStatus=${this.#optionsStatus.value}
      .usage=${this.#contextUsage.value}
      .agents=${this.#agents.value}
      .agent=${agentInfo(composer.agentId, this.#activeSession.value?.agentName ?? null)}
      .branches=${this.branches?.rootId === this.#rootId.value ? this.branches.names : []}
      .currentBranch=${this.#gitRepo.value.repo?.branch ?? null}
      .localShared=${this.#localShared.value}
      .localTurns=${this.#projectSettings.value.localTurns}
      .permission=${hasSession ? this.#permission.value : null}
      .notice=${hasSession ? this.#notice.value : null}
      .signInRun=${hasSession ? this.#signInRun() : null}
      .loginHere=${hasSession && this.#loginHere()}
      ?dropping=${this.dropping}
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
    ></acp-chat>`;
  }
}

customElements.define('acp-chat-view', AcpChatView);
