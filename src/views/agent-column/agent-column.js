import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { html, nothing } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '@symblight/wc-material/progress-circular';
import '../../components/chat/chat.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/session-header/session-header.js';
import { AcpTerminal } from '../../components/terminal/terminal.js';
import '../../components/welcome/welcome.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ChatSessionController } from '../../controllers/chat-session/ChatSessionController.js';
import { ChatPartsController } from '../../controllers/chat-parts/ChatPartsController.js';
import { SessionActionsController } from '../../controllers/session-actions/SessionActionsController.js';
import { cliInput } from '../../models/cli-input/cli-input.js';
import { chatDropOf } from '../../models/file-drop/file-drop.js';
import { inTurn } from '../../models/sessions/sessions.js';
import { USER_ID, acpAdapter } from '../../services/adapter/adapter.js';
import { agents } from '../../hooks/agents/agents.js';
import { droppedKinds, gitBranches, openUrl, quickOpen, saveAttachment } from '../../services/ipc/ipc.js';
import { fileDrop } from '../../services/file-drop/file-drop.js';
import { terminals } from '../../hooks/terminals/terminals.js';
import { sessionController } from '../../services/session-controller/session-controller.js';
import { $signIns, signInOf } from '../../stores/agents/agents.js';
import { $pendingInput, addDrop, hasPendingInput, takePendingInput } from '../../stores/chat/chat.js';
import { $now } from '../../stores/clock/clock.js';
import { $fileDropTarget } from '../../stores/file-drop/file-drop.js';
import { $agents, $composer, $composerOptionsStatus, agentInfo, selectAgent, setRunTarget } from '../../stores/composer/composer.js';
import { $activeContextUsage } from '../../stores/context-usage/context-usage.js';
import { openAgents } from '../../stores/editor/editor.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $activeFolder, $activeSession, $activeSessionId, $localShared } from '../../stores/sessions/sessions.js';
import { $activeNotice, $activePermission, $sessionNotices } from '../../stores/session-runtime/session-runtime.js';
import { $sessionTerminals, $terminals, openLoginTerminal } from '../../stores/terminals/terminals.js';
import { $activeShownView, $activeView } from '../../stores/session-views/session-views.js';
import { $editorFont, $editorFontSize } from '../../stores/settings/settings.js';
import { $openingPath, $rootId, $workspace, $workspaceSettings } from '../../stores/workspace/workspace.js';

/** Larger attachments aren't sent to be saved (the backend's cap). */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** @typedef {import('../../models/types/types.js').FileDrop} FileDrop */
/** @typedef {import('../../models/types/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../models/types/types.js').RunTarget} RunTarget */
/** @typedef {import('../../models/types/types.js').SessionView} SessionView */
/** @typedef {import('../../components/session-banner/session-banner.js').SessionAction} SessionAction */

/**
 * @tag acp-agent-column
 * @summary Agent chat for the opened project, or the active session's CLI in a terminal (the chat kept, hidden); the welcome screen until one is opened, a spinner while one opens.
 * @fires acp-file-open `{ path, line }` when a file chip or link in a message, or a tool call's location, is clicked
 * @fires acp-file-reveal `{ path }` when a folder chip or link in a message is clicked
 */
export class AcpAgentColumn extends ViewElement {
  static properties = {
    fileOptions: { state: true },
    branches: { state: true },
  };

  #workspace = new StoreController(this, { store: $workspace });
  #openingPath = new StoreController(this, { store: $openingPath });
  #composer = new StoreController(this, { store: $composer });
  #optionsStatus = new StoreController(this, { store: $composerOptionsStatus });
  #contextUsage = new StoreController(this, { store: $activeContextUsage });
  #agents = new StoreController(this, { store: $agents });
  #gitRepo = new StoreController(this, { store: $gitRepo });
  #rootId = new StoreController(this, { store: $rootId });
  #activeFolder = new StoreController(this, { store: $activeFolder });
  #permission = new StoreController(this, { store: $activePermission });
  #notice = new StoreController(this, { store: $activeNotice });
  /** Re-renders on a sign-in's change; `#signInRun()` reads it. */
  #signIns = new StoreController(this, { store: $signIns });
  #now = new StoreController(this, { store: $now });
  /** Whether a login's terminal is this window's; `#loginHere()` reads it. */
  #terminals = new StoreController(this, { store: $terminals });
  #activeSessionId = new StoreController(this, { store: $activeSessionId });
  #activeSession = new StoreController(this, { store: $activeSession });
  #localShared = new StoreController(this, { store: $localShared });
  #workspaceSettings = new StoreController(this, { store: $workspaceSettings });
  #activeView = new StoreController(this, { store: $activeView });
  #shownView = new StoreController(this, { store: $activeShownView });
  #sessionTerminals = new StoreController(this, { store: $sessionTerminals });
  #editorFont = new StoreController(this, { store: $editorFont });
  #editorFontSize = new StoreController(this, { store: $editorFontSize });
  #fileDropTarget = new StoreController(this, { store: $fileDropTarget });
  /** The header's rename, reset title, reveal and delete. */
  #sessionActions = new SessionActionsController(this, {
    confirm: () => this.renderRoot.querySelector('acp-confirm-dialog'),
  });

  /** @type {ChatSessionController} */
  #session = new ChatSessionController(this, { chat: () => this.#chat?.chat ?? null });
  /** @type {ChatPartsController} */
  #parts = new ChatPartsController(this, { attachments: () => /** @type {AcpChat} */ (this.#chat).attachments });

  /**
   * Code sent from the editors (selections, `<acp-comment-bar>`'s comments) and files dropped from the
   * OS go into the composer, or into the CLI of a session shown in the terminal.
   */
  #pendingInput = new StoreController(this, { store: $pendingInput });

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

  /** Whether the active session shows its CLI in place of the chat. */
  get #inTerminal() {
    return this.#workspace.value !== null && this.#openingPath.value === null && this.#activeSessionId.value !== null && this.#shownView.value === 'terminal';
  }

  /** @returns {AcpTerminal | null} The active session's CLI while it runs. */
  get #runningCli() {
    const terminal = this.renderRoot.querySelector('acp-terminal');
    return terminal && this.#terminals.value[terminal.terminalId]?.status === 'running' ? terminal : null;
  }

  /**
   * @param {Element | null} target
   * @returns {target is AcpTerminal} Whether it is the session's CLI shown here.
   */
  #isOwnTerminal(target) {
    return target instanceof AcpTerminal && this.contains(target);
  }

  /**
   * @param {Element | null} target
   * @returns {boolean} Whether it is the chat, shown here (not the session's CLI in its place).
   */
  #isShownChat(target) {
    return target !== null && target === this.#chat && !this.#inTerminal && this.#openingPath.value === null;
  }

  /**
   * Files dropped from the OS on the session's CLI (its paths typed in, as a native terminal does,
   * once it runs) or its chat (into the composer); kept until then.
   */
  #onFileDrop = (/** @type {Event} */ e) => {
    const { target, paths } = /** @type {CustomEvent<FileDrop>} */ (e).detail;
    if (this.#isOwnTerminal(target) || this.#isShownChat(target)) addDrop(paths);
  };

  /**
   * What waits for the shown session goes into its running CLI or its composer once up; otherwise
   * it keeps waiting (a CLI starting or ended, a composer not up yet).
   */
  async #applyPending() {
    const id = $activeSessionId.get();
    if (id === null || !hasPendingInput(id)) return;
    await this.updateComplete;
    const root = this.#activeFolder.value ?? this.#workspace.value?.path ?? null;
    if (this.#inTerminal) {
      const cli = this.#runningCli;
      if (!cli) return;
      const { inserts, drops } = takePendingInput(id);
      if (inserts.length) cli.paste(cliInput(inserts, root));
      if (drops.length) cli.paste(terminals.shellPaths(drops, app.platform));
      return;
    }
    const chat = this.#chat;
    if (!chat || this.#openingPath.value !== null || !(await chat.composerReady())) return;
    // Shown elsewhere meanwhile (another session, or this one's CLI): it waits.
    if ($activeSessionId.get() !== id || this.#inTerminal) return;
    const { inserts, drops } = takePendingInput(id);
    if (inserts.length) chat.insertCode(inserts);
    if (drops.length) this.#dropOnChat(id, drops);
  }

  /**
   * Dropped files and folders become chips, like `@` picks (an image too: the agent reads it by its
   * path). Kept for the session when another one shows meanwhile.
   * @param {string} sessionId
   * @param {readonly string[]} paths
   */
  async #dropOnChat(sessionId, paths) {
    const chat = this.#chat;
    const keep = () => addDrop(paths, sessionId);
    try {
      const kinds = await droppedKinds(paths);
      if ($activeSessionId.get() !== sessionId) return keep();
      const root = this.#activeFolder.value ?? this.#workspace.value?.path ?? null;
      const files = chatDropOf(paths.map((path, i) => ({ path, kind: kinds[i] })), root);
      if (!chat || !(await chat.composerReady()) || $activeSessionId.get() !== sessionId) return keep();
      chat.insertFiles(files);
    } catch (err) {
      app.reportError('Adding dropped files failed', err);
    }
  }

  /**
   * Files attached in the composer: each saved into the session's folder, the saved ones' path chips
   * put in, the others named in an error. A draft's chips are absolute: its folder may yet be a
   * worktree's, where the project's attachments aren't.
   * @param {Event} e
   */
  async #onAttach(e) {
    const { files } = /** @type {CustomEvent<{ files: File[] }>} */ (e).detail;
    const sessionId = $activeSessionId.get();
    const folder = this.#activeFolder.value ?? this.#workspace.value?.path ?? null;
    if (sessionId === null || folder === null) {
      app.reportError('Attaching the files failed', new Error('No session to attach them to'));
      return;
    }
    const draft = this.#activeSession.value === null;
    /** @type {string[]} */
    const paths = [];
    /** @type {string[]} */
    const failed = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        failed.push(`${file.name}: too large to attach (over ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`);
        continue;
      }
      try {
        paths.push(await saveAttachment(folder, file));
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failed.length) app.reportError('Attaching the files failed', new Error(failed.join('; ')));
    const chat = this.#chat;
    if ($activeSessionId.get() !== sessionId || !chat) return addDrop(paths, sessionId);
    chat.insertFiles(paths.map((path) => ({ path: draft ? path : (projects.rel(folder, path) ?? path), folder: false })));
  }

  connectedCallback() {
    super.connectedCallback();
    fileDrop.addEventListener('drop', this.#onFileDrop);
  }

  disconnectedCallback() {
    fileDrop.removeEventListener('drop', this.#onFileDrop);
    super.disconnectedCallback();
  }

  /**
   * What waited goes in once it can: the session's CLI showed (it was starting) or restarted, or the
   * chat did (its CLI had ended).
   */
  updated() {
    this.#applyPending();
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
      const { items, cancelled } = await quickOpen(rootId, query, 'all');
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
      const names = await gitBranches(rootId);
      if (rootId === $rootId.get()) this.branches = { rootId, names };
    } catch (err) {
      app.reportError('Listing branches failed', err);
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
    else if (action === 'open-terminal') sessionController.openInTerminal(id);
    else if (action === 'show-login') {
      const terminal = this.#signInRun()?.terminal;
      if (terminal && this.#loginHere()) openLoginTerminal(terminal, $workspace.get()?.path ?? null);
    }
    else if (action === 'restart') sessionController.restart(id);
    else if (action === 'turn-on-agent') {
      const agentId = $sessionNotices.get()[id]?.offAgent;
      if (agentId) agents.setEnabled(agentId, true);
    }
    else sessionController.dismissNotice(id);
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
    const { agentId } = /** @type {CustomEvent<{ agentId: string }>} */ (e).detail;
    selectAgent(agentId);
    // Its models load while the model picker waits (or shows the ones cached).
    agents.loadOptions(agentId);
  }

  /** A model, level, mode or permission option of the composer's agent. */
  #onConfigOption = (/** @type {Event} */ e) => {
    const { configId, value } = /** @type {CustomEvent<{ configId: string, value: string }>} */ (e).detail;
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
    openUrl(url).catch((err) => app.reportError('Opening the link failed', err));
  }

  /** Continue in the other view: ⌘⇧T, or the header's button. */
  toggleView() {
    const id = $activeSessionId.get();
    if (id !== null && $activeView.get().disabled === '') this.#switchView(id, $activeShownView.get() === 'terminal' ? 'chat' : 'terminal');
  }

  /** @param {Event} e */
  #onSessionView(e) {
    const { sessionId, view } = /** @type {CustomEvent<{ sessionId: string, view: SessionView }>} */ (e).detail;
    this.#switchView(sessionId, view);
  }

  /**
   * Asks first when the switch would stop work: a running turn (or one waiting for an answer) going
   * to the terminal, a busy CLI going back to chat.
   * @param {string} id
   * @param {SessionView} view
   */
  async #switchView(id, view) {
    const dialog = this.renderRoot.querySelector('acp-confirm-dialog');
    const status = this.#activeSession.value?.id === id ? this.#activeSession.value.status : null;
    if (view === 'terminal') {
      const asked = { headline: 'Stop the current turn?', message: 'Stop the current turn and continue in the terminal?', confirmLabel: 'Stop and continue' };
      if (inTurn(status, this.#permission.value !== null) && !(await dialog?.confirm(asked))) return;
      await sessionController.continueInTerminal(id);
      return;
    }
    if (await sessionController.cliBusy(id)) {
      const name = this.#activeSession.value?.agentName ?? 'the agent';
      const asked = { headline: `Close ${name}?`, message: `Close ${name} in the terminal? Its current reply stops.`, confirmLabel: 'Close and continue' };
      if (!(await dialog?.confirm(asked))) return;
    }
    await sessionController.continueInChat(id);
  }

  /** @param {Event} e */
  #onTerminalRestart(e) {
    e.stopPropagation();
    const id = $activeSessionId.get();
    if (id !== null) sessionController.restartCli(id);
  }

  /** @param {Event} e */
  #onTerminalChat(e) {
    e.stopPropagation();
    const id = $activeSessionId.get();
    if (id !== null) this.#switchView(id, 'chat');
  }

  /** @param {Event} e */
  #onTerminalCopy(e) {
    app.copy(/** @type {CustomEvent<{ text: string }>} */ (e).detail.text, 'Copying failed');
  }

  /**
   * @param {string | null} id
   * @returns {number} How many inputs wait for the session.
   */
  #waitingCount(id) {
    const pending = id === null ? undefined : this.#pendingInput.value[id];
    return pending ? pending.inserts.length + pending.drops.length : 0;
  }

  /** The terminal of the active session's CLI; `undefined` while it starts. */
  get #cliTerminalId() {
    const id = this.#activeSessionId.value;
    return id === null ? undefined : this.#sessionTerminals.value[id];
  }

  /** The active session's CLI; nothing while it starts (the panel's spinner covers that). */
  #renderTerminal() {
    const id = this.#activeSessionId.value;
    const terminalId = this.#cliTerminalId;
    if (terminalId === undefined) return nothing;
    return html`<acp-terminal
      class="acp-agent-column__terminal"
      chat-fallback
      terminal-id=${terminalId}
      .connect=${terminals.connect}
      .info=${this.#terminals.value[terminalId] ?? null}
      .fontFamily=${this.#editorFont.value}
      .fontSize=${this.#editorFontSize.value}
      .waiting=${this.#waitingCount(id)}
      ?dropping=${this.#isOwnTerminal(this.#fileDropTarget.value)}
      @acp-terminal-restart=${this.#onTerminalRestart}
      @acp-terminal-chat=${this.#onTerminalChat}
      @acp-terminal-copy=${this.#onTerminalCopy}
      @acp-link-open=${this.#onLinkOpen}
    ></acp-terminal>`;
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
      slot="header"
      class="acp-agent-column__header"
      session-id=${session?.id ?? ''}
      session-title=${session?.title ?? ''}
      ?draft=${session === null}
      ?provisional=${session?.titleSource === 'prompt'}
      ?resettable=${session?.titleSource === 'user' && session.agentTitle !== null}
      .session=${session}
      .permissionPending=${this.#permission.value !== null}
      .now=${this.#now.value}
      .view=${this.#shownView.value}
      view-disabled=${this.#activeView.value.disabled}
      @acp-session-new=${this.#onNewSession}
      @acp-session-view=${this.#onSessionView}
    ></acp-session-header>`;
  }

  #onOpenLocal() {
    projects.open().catch((err) => app.reportError('Opening folder failed', err));
  }

  render() {
    const opening = this.#openingPath.value !== null;
    const workspace = this.#workspace.value;
    const composer = this.#composer.value;
    const hasSession = this.#activeSessionId.value !== null;
    const inTerminal = this.#inTerminal;
    const startingCli = inTerminal && this.#cliTerminalId === undefined;
    // Hidden rather than removed while a project opens, so the chat keeps its state.
    return html`<acp-panel
      ?loading=${opening || startingCli}
      loading-label=${opening ? 'Opening project' : "Starting the agent's CLI"}
    >
      ${workspace !== null && !opening ? this.#renderHeader() : nothing}
      ${workspace !== null
        ? html`<acp-chat
            class="acp-agent-column__chat"
            ?hidden=${opening || inTerminal}
            .conversationId=${this.#session.conversationId}
            ?empty=${this.#session.empty}
            .adapter=${acpAdapter}
            .userId=${USER_ID}
            .partElements=${this.#parts.partElements}
            .root=${this.#activeFolder.value ?? workspace.path}
            .fileOptions=${this.fileOptions}
            .composer=${composer}
            .optionsStatus=${this.#optionsStatus.value}
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
            ?dropping=${this.#isShownChat(this.#fileDropTarget.value)}
            @acp-chat-file-query=${this.#onFileQuery}
            @acp-chat-attach=${this.#onAttach}
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
      ${inTerminal ? this.#renderTerminal() : nothing}
      <acp-confirm-dialog></acp-confirm-dialog>
    </acp-panel>`;
  }
}

/** @typedef {import('../../components/chat/chat.js').AcpChat} AcpChat */

customElements.define('acp-agent-column', AcpAgentColumn);
