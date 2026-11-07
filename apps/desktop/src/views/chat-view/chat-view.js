import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { html } from 'lit';
import { ViewElement } from '../../components/view-element/view-element.js';
import '../../components/chat/chat.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ChatSessionController } from '../../controllers/chat-session/ChatSessionController.js';
import { ChatPartsController } from '../../controllers/chat-parts/ChatPartsController.js';
import { agents } from '../../hooks/agents/agents.js';
import { agentsMd } from '../../hooks/agents-md/agents-md.js';
import { search } from '../../hooks/search/search.js';
import { sessions } from '../../hooks/sessions/sessions.js';
import { $signIns, signInOf } from '../../stores/agents/agents.js';
import { $agents, $composer, $composerOptionsStatus, agentInfo, selectAgent, setRunTarget } from '../../stores/composer/composer.js';
import { composer as composerRules } from '../../hooks/composer/composer.js';
import { git } from '../../hooks/git/git.js';
import { $uncommittedCount } from '../../stores/git/git.js';
import { $activeContextUsage } from '../../stores/context-usage/context-usage.js';
import { openAgents } from '../../stores/editor/editor.js';
import { $activeFolder, $activeSession, $activeSessionId, $draftSessions } from '../../stores/sessions/sessions.js';
import { $activeNotice, $activePermission, $activeSubagent, $sessionNotices, showSubagent } from '../../stores/session-runtime/session-runtime.js';
import { $terminals, openLoginTerminal } from '../../stores/terminals/terminals.js';
import { $project } from '../../stores/project/project.js';
import { $activeWorkspace, $rootId, $shownFolder, $workspaces, MAIN } from '../../stores/workspaces/workspaces.js';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { $workspacesEnabled } from '../../stores/workspace-status/workspace-status.js';

/** @typedef {import('../../hooks/search/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../components/session-banner/session-banner.js').SessionAction} SessionAction */
/** @typedef {import('../../components/chat/chat.js').AcpChat} AcpChat */
/** @typedef {import('../../components/chat/chat.js').ChatPlace} ChatPlace */
/** @typedef {import('../../hooks/git/types.js').BranchList} BranchList */
/** @typedef {import('../../hooks/git/types.js').RootChanges} RootChanges */

/** @type {BranchList} */
const NO_BRANCHES = { local: [], remotes: [], default: null };

/**
 * @tag acp-chat-view
 * @summary The shown session's chat wired to its data: the conversation, the composer's agent and model (blocked while its workspace's folder is missing), a draft's place (New worktree's base from Main's branches), the banner's permission, notice and sign-in, the offer to create AGENTS.md, `@` file picks; a subagent's read-only chat in its place (Stop, Back).
 * @fires acp-file-open `{ path, line }` when a file chip or link in a message, or a tool call's location, is clicked
 * @fires acp-file-reveal `{ path }` when a folder chip or link in a message is clicked
 */
export class AcpChatView extends ViewElement {
  static properties = {
    concealed: { type: Boolean },
    dropping: { type: Boolean },
    fileOptions: { state: true },
    branches: { state: true },
    mainBranch: { state: true },
    needsAgentsMd: { state: true },
  };

  #project = new StoreController(this, { store: $project });
  #composer = new StoreController(this, { store: $composer });
  #optionsStatus = new StoreController(this, { store: $composerOptionsStatus });
  #contextUsage = new StoreController(this, { store: $activeContextUsage });
  #agents = new StoreController(this, { store: $agents });
  #workspace = new StoreController(this, { store: $activeWorkspace });
  #workspaces = new StoreController(this, { store: $workspaces });
  #drafts = new StoreController(this, {
    store: $draftSessions,
    // A draft started or gone is no longer fetched for.
    onChange: (drafts) => {
      for (const id of this.#fetchedFor) if (!(id in drafts)) this.#fetchedFor.delete(id);
    },
  });
  #workspacesEnabled = new StoreController(this, { store: $workspacesEnabled });
  #uncommitted = new StoreController(this, { store: $uncommittedCount });
  #activeFolder = new StoreController(this, { store: $activeFolder });
  #rootId = new StoreController(this, { store: $rootId });
  #activeSessionId = new StoreController(this, { store: $activeSessionId });
  #activeSession = new StoreController(this, { store: $activeSession });
  #permission = new StoreController(this, { store: $activePermission });
  #subagent = new StoreController(this, { store: $activeSubagent });
  #notice = new StoreController(this, { store: $activeNotice });
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
  /** The draft whose New worktree has Main's branches listed. */
  #branchesFor = /** @type {string | null} */ (null);
  /** @type {Set<string>} Drafts whose base menu fetched Main's branches: once each. */
  #fetchedFor = new Set();
  /** @type {string | null} The root whose branches `branches` holds (or is being listed for). */
  #listedFor = null;
  /** @type {(() => void) | null} Stops `git.watchChanges()`. */
  #unwatchChanges = null;
  /** @type {(() => void) | null} Stops `#onRootChange`. */
  #unwatchRoot = null;
  /** @type {string | null} The root `needsAgentsMd` is about, while a draft is on screen. */
  #agentsMdRoot = null;

  constructor() {
    super();
    /** @type {boolean} The chat stays rendered, so it keeps its state, but is not shown. */
    this.concealed = false;
    /** @type {boolean} Files from the OS are dragged over the chat. */
    this.dropping = false;
    /** @type {QuickOpenItem[]} */
    this.fileOptions = [];
    /** @type {BranchList} Main's, for a draft's New worktree. */
    this.branches = NO_BRANCHES;
    /** @type {string | null} Main's checked-out branch. */
    this.mainBranch = null;
    /** @type {boolean} The shown draft's folder has no AGENTS.md. */
    this.needsAgentsMd = false;
  }

  /** @returns {ChatPlace | null} The shown draft's footer. */
  get #place() {
    const id = this.#activeSessionId.value;
    const draft = id === null ? undefined : this.#drafts.value[id];
    if (draft === undefined) return null;
    const worktrees = this.#workspacesEnabled.value;
    const target = composerRules.runTargetOf(this.#composer.value.runTarget, draft.workspaceId, worktrees);
    const workspaceName =
      draft.workspaceId === MAIN ? null : (this.#workspaces.value.find((w) => w.id === draft.workspaceId)?.name ?? 'This workspace');
    const base = target.kind === 'worktree' ? (target.base ?? workspaces.defaultBase(this.branches, this.mainBranch)) : null;
    return { target, workspaceName, worktrees, branches: this.branches, base, load: this.#loadBranches };
  }

  /** A draft is on screen: its hint counts the shown folder's uncommitted files, and its offer looks for AGENTS.md there. */
  get #draftOnScreen() {
    const id = this.#activeSessionId.value;
    return id !== null && id in this.#drafts.value && !this.concealed && this.isConnected;
  }

  #syncDraftWatches() {
    const onScreen = this.#draftOnScreen;
    if (onScreen) {
      this.#unwatchChanges ??= git.watchChanges();
      this.#unwatchRoot ??= projects.onFsChange(this.#onRootChange);
    } else {
      this.#unwatchChanges?.();
      this.#unwatchChanges = null;
      this.#unwatchRoot?.();
      this.#unwatchRoot = null;
    }
    const rootId = onScreen ? this.#rootId.value : null;
    if (rootId !== this.#agentsMdRoot) {
      this.#agentsMdRoot = rootId;
      this.needsAgentsMd = false;
      void this.#askAgentsMd();
    }
  }

  #onRootChange = (/** @type {RootChanges} */ { dirs }) => {
    if (dirs.includes('')) void this.#askAgentsMd();
  };

  async #askAgentsMd() {
    const rootId = this.#agentsMdRoot;
    if (rootId === null) return;
    // It fails only for a root closed meanwhile, and nobody asked: no offer, no notice.
    const needed = await agentsMd.needed(rootId).catch(() => false);
    if (rootId === this.#agentsMdRoot) this.needsAgentsMd = needed;
  }

  /** The hint's files are in the shown folder, whatever place the draft had picked. */
  #onHintUse() {
    const id = this.#activeSessionId.value;
    const draft = id === null ? undefined : this.#drafts.value[id];
    if (id !== null && draft) setRunTarget(id, composerRules.runTargetOf(undefined, draft.workspaceId));
  }

  willUpdate() {
    this.#syncDraftWatches();
    // New worktree shown for a draft: Main's branches listed, for its default base.
    const id = this.#activeSessionId.value;
    if (id !== null && id !== this.#branchesFor && this.#place?.target.kind === 'worktree') {
      this.#branchesFor = id;
      void this.#listBranches();
    }
  }

  // A new workspace starts from Main's branches, whichever workspace is shown.
  #listBranches = async () => {
    const rootId = $project.get()?.rootId ?? null;
    if (rootId === null) return;
    // Never another project's: what was listed for another root goes (the same root's stays shown
    // while it's listed again), and an answer for a project no longer shown is dropped.
    if (rootId !== this.#listedFor) {
      this.#listedFor = rootId;
      this.branches = NO_BRANCHES;
      this.mainBranch = null;
    }
    try {
      const [branches, mainBranch] = await Promise.all([git.branches(rootId), git.branchOf(rootId)]);
      if ($project.get()?.rootId !== rootId) return;
      this.branches = branches;
      this.mainBranch = mainBranch;
    } catch (err) {
      app.reportError('Listing branches failed', err);
    }
  };

  // Each opening of the base menu lists Main's branches again; a draft's first waits for a fetch of Main's repository.
  #loadBranches = async () => {
    const id = $activeSessionId.get();
    const rootId = $project.get()?.rootId ?? null;
    if (id === null || rootId === null) return;
    if (!this.#fetchedFor.has(id)) {
      this.#fetchedFor.add(id);
      try {
        await git.fetch(rootId);
      } catch (err) {
        app.reportError('Fetching branches failed', err);
      }
    }
    await this.#listBranches();
  };

  /** @param {Event} e A draft's place picked in its footer. */
  #onRunTarget(e) {
    const { target } = /** @type {CustomEvent<{ target: import('../../hooks/composer/types.js').RunTarget }>} */ (e).detail;
    const id = $activeSessionId.get();
    if (id !== null) setRunTarget(id, target);
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
      if (terminal && this.#loginHere()) openLoginTerminal(terminal, $shownFolder.get());
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
  #onWorkspaceRecreate(e) {
    const { id } = /** @type {CustomEvent<{ id: string }>} */ (e).detail;
    workspaces.recreate(id);
  }

  /** @param {Event} e */
  #onLinkOpen(e) {
    const { url } = /** @type {CustomEvent<{ url: string }>} */ (e).detail;
    app.openUrl(url).catch((err) => app.reportError('Opening the link failed', err));
  }

  /** A subagent's card in the chat (`ChatPartsController`, on this element): its read-only chat. */
  #onSubagentOpen = (/** @type {Event} */ e) => {
    showSubagent(/** @type {CustomEvent<{ sessionId: string, subagentId: string }>} */ (e).detail);
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('acp-subagent-open', this.#onSubagentOpen);
    this.#syncDraftWatches();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('acp-subagent-open', this.#onSubagentOpen);
    this.#syncDraftWatches();
  }

  /** @param {Event} e The subagent's bar asks to stop it. */
  #onSubagentStop(e) {
    const sessionId = this.#activeSessionId.value;
    const { subagentId } = /** @type {CustomEvent<{ subagentId: string }>} */ (e).detail;
    if (sessionId !== null) sessions.cancelSubagent(sessionId, subagentId);
  }

  /** The subagent shown in place of the chat, with its chat's title. */
  get #shownSubagent() {
    const subagent = this.#subagent.value;
    return subagent === null ? null : { subagent, chatTitle: this.#activeSession.value?.title ?? '' };
  }

  render() {
    const project = this.#project.value;
    if (project === null) return html``;
    const subagent = this.#shownSubagent;
    const sessionId = this.#activeSessionId.value;
    const composer = this.#composer.value;
    const hasSession = this.#activeSessionId.value !== null;
    const workspace = this.#workspace.value;
    return html`<acp-chat
      ?hidden=${this.concealed}
      .conversationId=${subagent && sessionId !== null ? sessions.subagentConversationId(sessionId, subagent.subagent.id) : this.#session.conversationId}
      .subagent=${subagent}
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
      .blocked=${workspace?.missing ? { message: 'Recreate the folder to continue', workspaceId: workspace.id } : null}
      .place=${this.#place}
      .uncommitted=${this.#draftOnScreen ? this.#uncommitted.value : 0}
      .agentsMdOffer=${this.needsAgentsMd}
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
      @acp-workspace-recreate=${this.#onWorkspaceRecreate}
      @acp-run-target-change=${this.#onRunTarget}
      @acp-chat-hint-use=${this.#onHintUse}
      @acp-link-open=${this.#onLinkOpen}
      @acp-subagent-stop=${this.#onSubagentStop}
      @acp-subagent-close=${() => showSubagent(null)}
    ></acp-chat>`;
  }
}

customElements.define('acp-chat-view', AcpChatView);
