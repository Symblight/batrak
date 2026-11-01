import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { buildChipElement, createSplitOnSendHandler } from '@symblight/chat';
import '@symblight/chat/agent';
import { ChxCommandPicker } from '@symblight/chat/composer';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import styles from './chat.css?inline';
import { COMMAND_CHIP_TEMPLATE } from '../../controllers/chat-parts/ChatPartsController.js';
import { FileMentionsController } from '../../controllers/file-mentions/FileMentionsController.js';
import { buildMenuItem, codeChip, commentLines, fileChipAttrs } from './chips.js';
import { chat } from '../../hooks/chat/chat.js';
import '../agent-picker/agent-picker.js';
import '../context-meter/context-meter.js';
import '../mode-picker/mode-picker.js';
import '../model-picker/model-picker.js';
import '../part-thinking/part-thinking.js';
import '../run-target/run-target.js';
import '../session-banner/session-banner.js';

/** @typedef {import('@symblight/chat/composer').ChxAttachments} ChxAttachments */
/** @typedef {import('./chips.js').ComposerTextbox} ComposerTextbox */
/** @typedef {import('./chips.js').PmSchema} PmSchema */
/** @typedef {import('../../models/types/types.js').ContextUsage} ContextUsage */
/** @typedef {import('../../models/types/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../models/types/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types/types.js').ChatFile} ChatFile */
/** @typedef {import('../../models/types/types.js').CatalogAgent} CatalogAgent */
/** @typedef {import('../../models/types/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../../models/types/types.js').ComposerState} ComposerState */
/** @typedef {import('../../models/types/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../../models/types/types.js').SessionNotice} SessionNotice */
/** @typedef {import('@symblight/chat').ChxChat} ChxChat */

const SLASH_COMMANDS = ['clear', 'compact', 'init', 'review'];

// Sends arrive as one flat html part; re-split them so chips and pastes keep their own renderers.
const splitOnSend = createSplitOnSendHandler(chat.MESSAGE_PART_RULES);

/**
 * @tag acp-chat
 * @summary Agent chat for the active session (only the composer, centered, until its first message): message list plus a composer with `@` file mentions, `/` commands, attachments, paste chips, and the agent's model, mode, context and run target.
 * @fires acp-chat-file-query `{ query }` Files and folders for `@` to search for; `null` drops the search.
 * @fires acp-chat-attach `{ files }` Files attached (picked, pasted): saved, they come back as path chips (`insertFiles()`).
 */
export class AcpChat extends LitElement {
  static properties = {
    /** `<chx-chat>`'s `activeConversationId`: the active session's id. */
    conversationId: { attribute: false },
    /** The active session is a draft with no message yet: only the composer shows. */
    empty: { type: Boolean },
    adapter: { attribute: false },
    userId: { attribute: false },
    partElements: { attribute: false },
    /** The project's path. */
    root: { attribute: false },
    /** Matches for the last `acp-chat-file-query`. */
    fileOptions: { attribute: false },
    composer: { attribute: false },
    usage: { attribute: false },
    agents: { attribute: false },
    agent: { attribute: false },
    /** Whether the composer's agent's config options are being asked for, or that failed. */
    optionsStatus: { attribute: false },
    branches: { attribute: false },
    currentBranch: { attribute: false },
    localShared: { attribute: false },
    localTurns: { attribute: false },
    permission: { attribute: false },
    notice: { attribute: false },
    signInRun: { attribute: false },
    /** Files dragged from the OS are over it. */
    dropping: { type: Boolean, reflect: true },
  };

  static styles = styles;

  #mentions = new FileMentionsController(this, {
    picker: () => /** @type {ChxCommandPicker | null} */ (this.renderRoot.querySelector('#acp-chat-files')),
    composer: () => this.renderRoot.querySelector('chx-message-composer'),
    options: () => this.fileOptions,
    onQuery: (query) => this.#emit('acp-chat-file-query', { query }),
  });

  constructor() {
    super();
    /** @type {string | undefined} */
    this.conversationId = undefined;
    /** @type {boolean} */
    this.empty = false;
    /** @type {ChxChat['adapter']} */
    this.adapter = undefined;
    /** @type {string} */
    this.userId = '';
    /** @type {ChxChat['partElements']} */
    this.partElements = undefined;
    /** @type {string | null} */
    this.root = null;
    /** @type {readonly QuickOpenItem[]} */
    this.fileOptions = [];
    /** @type {ComposerState | null} */
    this.composer = null;
    /** @type {ContextUsage | null} The session's context usage as its agent last reported it. */
    this.usage = null;
    /** @type {readonly CatalogAgent[]} */
    this.agents = [];
    /** @type {AgentInfo | null} */
    this.agent = null;
    /** @type {import('../../models/types/types.js').AgentOptionsStatus | null} */
    this.optionsStatus = null;
    /** @type {readonly string[]} */
    this.branches = [];
    /** @type {string | null} */
    this.currentBranch = null;
    /** @type {number} Other local sessions of the project with a running agent, for the run target. */
    this.localShared = 0;
    /** @type {import('../../models/types/types.js').LocalTurns} */
    this.localTurns = 'queue';
    /** @type {PermissionRequest | null} */
    this.permission = null;
    /** @type {SessionNotice | null} */
    this.notice = null;
    /** @type {import('../../models/types/types.js').SignInRun | null} The sign-in of the notice's agent. */
    this.signInRun = null;
    /** @type {boolean} */
    this.dropping = false;
  }

  /** The `<chx-chat>` holding every session's conversation; present after the first render. */
  get chat() {
    return this.renderRoot?.querySelector('chx-chat') ?? null;
  }

  /** The composer's attachments; present after the first render. */
  get attachments() {
    return this.#attachments;
  }

  /** @returns {Promise<ComposerTextbox | null>} The composer's textbox once its editor is up. */
  async #textbox() {
    await this.updateComplete;
    const composer = /** @type {import('lit').LitElement | null} */ (this.renderRoot.querySelector('chx-message-composer'));
    await composer?.updateComplete;
    const textbox = /** @type {ComposerTextbox | null} */ (composer?.renderRoot.querySelector('chx-textbox') ?? null);
    await textbox?.updateComplete;
    return textbox?.editor?.view ? textbox : null;
  }

  /** Whether code can go into the composer now (`insertCode()`). */
  async composerReady() {
    return (await this.#textbox()) !== null;
  }

  /**
   * Code sent from the editors into the composer: a selection's chip at the caret, a comment as its
   * own line after the draft (replacing an empty one). Call once `composerReady()`.
   * @param {readonly ChatInsert[]} inserts
   */
  insertCode(inserts) {
    const textbox = this.#readyTextbox;
    const view = textbox?.editor?.view;
    if (!textbox || !view || !inserts.length) return;
    const { schema, selection } = view.state;
    let tr = view.state.tr;
    const chips = inserts.filter((i) => !i.body).flatMap((i) => [codeChip(schema, i, this.root), schema.text(' ')]);
    if (chips.length) tr = tr.replaceWith(selection.from, selection.to, chips);
    const lines = inserts.filter((i) => i.body).flatMap((i) => commentLines(schema, i, this.root));
    if (lines.length) {
      const { doc } = tr;
      const empty = doc.childCount === 1 && doc.child(0).content.size === 0;
      tr = empty ? tr.replaceWith(0, doc.content.size, lines) : tr.insert(doc.content.size, lines);
    }
    view.dispatch(tr);
    if (lines.length) textbox.focusEnd();
    else textbox.focus(); // the caret stays after the chips
  }

  /**
   * Files and folders as chips at the caret, like ones picked with `@`. Call once `composerReady()`.
   * @param {readonly ChatFile[]} files
   */
  insertFiles(files) {
    const textbox = this.#readyTextbox;
    const view = textbox?.editor?.view;
    if (!textbox || !view || !files.length) return;
    const { schema, selection } = view.state;
    const chips = files.flatMap((f) => [schema.nodes.chip.create(fileChipAttrs(f.path, f.folder)), schema.text(' ')]);
    view.dispatch(view.state.tr.replaceWith(selection.from, selection.to, chips));
    textbox.focus();
  }

  /** @returns {ComposerTextbox | null} The composer's textbox, as it is now. */
  get #readyTextbox() {
    return /** @type {ComposerTextbox | null} */ (
      /** @type {import('lit').LitElement | null} */ (this.renderRoot.querySelector('chx-message-composer'))
        ?.renderRoot.querySelector('chx-textbox') ?? null
    );
  }

  /** Rendered unconditionally, so present after the first render. */
  get #attachments() {
    return /** @type {ChxAttachments} */ (this.renderRoot.querySelector('chx-attachments'));
  }

  /**
   * Files being attached (picked, pasted) go to the column instead, which saves them where the agent
   * reads them and puts their path chips in (`insertFiles()`): the composer keeps no attachments,
   * which no view could send.
   * @param {Event} e
   */
  #onAttach(e) {
    e.preventDefault();
    this.#emit('acp-chat-attach', { files: [.../** @type {CustomEvent<{ files: File[] }>} */ (e).detail.files] });
  }

  /** @param {Event} e */
  #onMessagesChange(e) {
    splitOnSend(/** @type {Parameters<typeof splitOnSend>[0]} */ (e));
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Event} e */
  #onCommandPicked(e) {
    const { value, setChip } = /** @type {CustomEvent<{ value: string, setChip: (chip: HTMLElement) => void }>} */ (e)
      .detail;
    setChip(buildChipElement({ templateId: COMMAND_CHIP_TEMPLATE, label: `/${value}`, icon: null, data: {} }));
  }

  /** `/` filter over the agent's commands. */
  #onCommandQuery = (/** @type {Event} */ e) => {
    const picker = /** @type {ChxCommandPicker} */ (e.target);
    const query = /** @type {CustomEvent<{ value: string | null }>} */ (e).detail.value;
    picker.clearOptions();
    if (query === null) return;
    const needle = query.toLowerCase();
    const options = document.createDocumentFragment();
    for (const command of SLASH_COMMANDS.filter((c) => c.includes(needle))) {
      options.append(buildMenuItem(command, `/${command}`));
    }
    picker.addOptions(options);
  };

  render() {
    const empty = this.empty;
    return html`
      <chx-chat
        class=${classMap({ 'acp-chat__chat': true, 'acp-chat__chat_empty': empty })}
        .userId=${this.userId}
        .activeConversationId=${this.conversationId}
        .adapter=${this.adapter}
        .partElements=${this.partElements}
        .noVirtualization=${true}
        @chx-messages-change=${this.#onMessagesChange}
      >
        <!-- "auto": WebKit sends a smooth pin scroll to an older turn instead of the sent message. -->
        <chx-message-list
          slot="message-list"
          class="acp-chat__message-list"
          ?hidden=${empty}
          scroll-behavior="auto"
          content-align="start"
          scroll-mode="pin-top"
        >
          <!-- Waiting for the reply's first update: the agent thinking, as its thoughts look. -->
          <acp-part-thinking slot="streaming" class="acp-chat__streaming"></acp-part-thinking>
          <chx-scroll-to-bottom-affordance slot="scroll-to-bottom"></chx-scroll-to-bottom-affordance>
        </chx-message-list>
        <acp-session-banner
          slot="input-banner"
          class="acp-chat__banner"
          .permission=${this.permission}
          .notice=${this.notice}
          .signInRun=${this.signInRun}
        ></acp-session-banner>
        <chx-message-composer
          slot="message-composer"
          class="acp-chat__composer"
          placeholder="Describe a task, @ to mention, / for commands"
          layout="stacked"
          send-button="always"
          busy-action="stop"
        >
          <md-icon-button slot="leading" aria-label="Attach files" @click=${() => this.#attachments.open()}>
            <md-icon class="acp-chat__attach-icon">${unsafeSVG(addIcon)}</md-icon>
          </md-icon-button>
          <acp-agent-picker
            slot="leading"
            class="acp-chat__agent-picker"
            .composer=${this.composer}
            .agents=${this.agents}
            .agent=${this.agent}
          ></acp-agent-picker>
          <acp-model-picker
            slot="leading"
            class="acp-chat__model-picker"
            .options=${this.composer?.configOptions ?? []}
            .status=${this.optionsStatus}
            .signIn=${this.agent?.signIn === true}
          ></acp-model-picker>
          <chx-attachments slot="attachments" @chx-attach=${this.#onAttach}></chx-attachments>
          <chx-paste-long-text></chx-paste-long-text>
          <chx-code-block-paste></chx-code-block-paste>
          <chx-command-picker
            id="acp-chat-files"
            slot="command-field"
            commandCharacter="@"
            maxQuerySpaces="2"
            .resolve=${this.#mentions.resolve}
            @chx-command-query=${this.#mentions.onQuery}
            @chx-command-picked=${this.#mentions.onPicked}
          ></chx-command-picker>
          <chx-command-picker
            id="acp-chat-commands"
            slot="command-field"
            commandCharacter="/"
            @chx-command-query=${this.#onCommandQuery}
            @chx-command-picked=${this.#onCommandPicked}
          ></chx-command-picker>
          <acp-mode-picker slot="actions" .options=${this.composer?.configOptions ?? []}></acp-mode-picker>
          ${this.composer?.agentId
            ? html`<acp-context-meter slot="actions" .usage=${this.usage}></acp-context-meter>`
            : nothing}
          <!-- Where the session runs is picked before the first message; the footer goes with it. -->
          ${empty
            ? html`<acp-run-target
                slot="footer"
                class="acp-chat__run-target"
                .composer=${this.composer}
                .branches=${this.branches}
                .currentBranch=${this.currentBranch}
                .localShared=${this.localShared}
                .localTurns=${this.localTurns}
              ></acp-run-target>`
            : nothing}
        </chx-message-composer>
      </chx-chat>
    `;
  }
}

customElements.define('acp-chat', AcpChat);
