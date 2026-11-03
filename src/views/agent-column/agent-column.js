import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { html, nothing } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/panel/panel.js';
import '@symblight/wc-material/progress-circular';
import '../chat-view/chat-view.js';
import '../../components/confirm-dialog/confirm-dialog.js';
import '../../components/session-header/session-header.js';
import '../terminal-view/terminal-view.js';
import '../../components/welcome/welcome.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { SessionActionsController } from '../../controllers/session-actions/SessionActionsController.js';
import { SessionInputController } from '../../controllers/session-input/SessionInputController.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $pendingInput } from '../../stores/chat/chat.js';
import { $now } from '../../stores/clock/clock.js';
import { $fileDropTarget } from '../../stores/file-drop/file-drop.js';
import { $activeFolder, $activeSession, $activeSessionId } from '../../stores/sessions/sessions.js';
import { $activePermission } from '../../stores/session-runtime/session-runtime.js';
import { $sessionTerminals, $terminals } from '../../stores/terminals/terminals.js';
import { $activeShownView, $activeView } from '../../stores/session-views/session-views.js';
import { $openingPath, $project } from '../../stores/project/project.js';
import { $activeWorkspaceId } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('../../hooks/sessions/types.js').SessionView} SessionView */

/**
 * @tag acp-agent-column
 * @summary Agent chat for the opened project, or the active session's CLI in a terminal (the chat kept, hidden); the welcome screen until one is opened, a spinner while one opens.
 * @fires acp-file-open `{ path, line }` when a file chip or link in a message, or a tool call's location, is clicked
 * @fires acp-file-reveal `{ path }` when a folder chip or link in a message is clicked
 */
export class AcpAgentColumn extends ViewElement {
  #project = new StoreController(this, { store: $project });
  #openingPath = new StoreController(this, { store: $openingPath });
  #activeFolder = new StoreController(this, { store: $activeFolder });
  #permission = new StoreController(this, { store: $activePermission });
  #now = new StoreController(this, { store: $now });
  #terminals = new StoreController(this, { store: $terminals });
  #activeSessionId = new StoreController(this, { store: $activeSessionId });
  #activeSession = new StoreController(this, { store: $activeSession });
  #activeView = new StoreController(this, { store: $activeView });
  #shownView = new StoreController(this, { store: $activeShownView });
  #sessionTerminals = new StoreController(this, { store: $sessionTerminals });
  #fileDropTarget = new StoreController(this, { store: $fileDropTarget });
  /** The header's rename, reset title, reveal and delete. */
  #sessionActions = new SessionActionsController(this, {
    confirm: () => this.renderRoot.querySelector('acp-confirm-dialog'),
  });

  /** Code and files given to the shown session besides typing: dropped, attached, sent from the editors. */
  #input = new SessionInputController(this, {
    chat: () => this.#chat,
    cli: () => this.#runningCli,
    inTerminal: () => this.#inTerminal,
    opening: () => this.#openingPath.value !== null,
    root: () => this.#activeFolder.value ?? this.#project.value?.path ?? null,
    draft: () => this.#activeSession.value === null,
  });

  /**
   * Code sent from the editors (selections, `<acp-comment-bar>`'s comments) and files dropped from the
   * OS go into the composer, or into the CLI of a session shown in the terminal.
   */
  #pendingInput = new StoreController(this, { store: $pendingInput });

  /** @returns {AcpChat | null} */
  get #chat() {
    return this.renderRoot?.querySelector('acp-chat-view')?.chat ?? null;
  }

  /** Done once the chat has rendered what this update gave it too (the input waits for its composer). */
  async getUpdateComplete() {
    const result = await super.getUpdateComplete();
    await this.renderRoot?.querySelector('acp-chat-view')?.updateComplete;
    await this.renderRoot?.querySelector('acp-terminal-view')?.updateComplete;
    return result;
  }

  /** Whether the active session shows its CLI in place of the chat. */
  get #inTerminal() {
    return this.#project.value !== null && this.#openingPath.value === null && this.#activeSessionId.value !== null && this.#shownView.value === 'terminal';
  }

  /** @returns {HTMLElementTagNameMap['acp-terminal'] | null} The active session's CLI while it runs. */
  get #runningCli() {
    const terminal = this.renderRoot.querySelector('acp-terminal');
    return terminal && this.#terminals.value[terminal.terminalId]?.status === 'running' ? terminal : null;
  }

  /** @param {Event} e */
  #onLinkOpen(e) {
    const { url } = /** @type {CustomEvent<{ url: string }>} */ (e).detail;
    app.openUrl(url).catch((err) => app.reportError('Opening the link failed', err));
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
      if (sessions.inTurn(status, this.#permission.value !== null) && !(await dialog?.confirm(asked))) return;
      await sessions.continueInTerminal(id);
      return;
    }
    if (await sessions.cliBusy(id)) {
      const name = this.#activeSession.value?.agentName ?? 'the agent';
      const asked = { headline: `Close ${name}?`, message: `Close ${name} in the terminal? Its current reply stops.`, confirmLabel: 'Close and continue' };
      if (!(await dialog?.confirm(asked))) return;
    }
    await sessions.continueInChat(id);
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
    if (id === null || terminalId === undefined) return nothing;
    return html`<acp-terminal-view
      terminal-id=${terminalId}
      session-id=${id}
      @acp-session-view=${this.#onSessionView}
      @acp-link-open=${this.#onLinkOpen}
    ></acp-terminal-view>`;
  }

  #onNewSession() {
    const project = $project.get();
    if (project) sessions.create(project.path, $activeWorkspaceId.get());
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
    const project = this.#project.value;
    const inTerminal = this.#inTerminal;
    const startingCli = inTerminal && this.#cliTerminalId === undefined;
    // Hidden rather than removed while a project opens, so the chat keeps its state.
    return html`<acp-panel
      ?loading=${opening || startingCli}
      loading-label=${opening ? 'Opening project' : "Starting the agent's CLI"}
    >
      ${project !== null && !opening ? this.#renderHeader() : nothing}
      <!-- Always rendered, so its controllers (a session's unsent composer text) outlive a closed project. -->
      <acp-chat-view
        ?concealed=${opening || inTerminal}
        ?dropping=${this.#input.isShownChat(this.#fileDropTarget.value)}
        @acp-chat-attach=${this.#input.onAttach}
      ></acp-chat-view>
      ${project === null
        ? html`<acp-welcome
            class="acp-agent-column__welcome"
            ?hidden=${opening}
            @acp-open-local=${this.#onOpenLocal}
          ></acp-welcome>`
        : nothing}
      ${inTerminal ? this.#renderTerminal() : nothing}
      <acp-confirm-dialog></acp-confirm-dialog>
    </acp-panel>`;
  }
}

/** @typedef {import('../../components/chat/chat.js').AcpChat} AcpChat */

customElements.define('acp-agent-column', AcpAgentColumn);
