import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { buildChipElement, createSplitOnSendHandler } from '@symblight/chat';
import '@symblight/chat/agent';
import { ChxCommandPicker } from '@symblight/chat/composer';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import folderIcon from '@material-design-icons/svg/outlined/folder.svg?raw';
import chevronIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import { fileIconFor } from '../../models/file-icons.js';
import { basename, relPath } from '../../models/paths.js';
import styles from './acp-chat.css?inline';
import { COMMAND_CHIP_TEMPLATE, FILE_CHIP_TEMPLATE } from '../../controllers/chat-parts/ChatPartsController.js';
import { MESSAGE_PART_RULES } from '../../models/chat-parts.js';
import '../acp-agent-picker/acp-agent-picker.js';
import '../acp-context-meter/acp-context-meter.js';
import '../acp-mode-picker/acp-mode-picker.js';
import '../acp-model-picker/acp-model-picker.js';
import '../acp-part-thinking/acp-part-thinking.js';
import '../acp-run-target/acp-run-target.js';
import '../acp-session-banner/acp-session-banner.js';

/** @typedef {import('@symblight/chat/composer').ChxAttachments} ChxAttachments */
/** @typedef {Parameters<ChxCommandPicker['resolve']>[0]} MenuItemElement */
/** @typedef {import('../../models/types.js').ContextUsage} ContextUsage */
/** @typedef {import('../../models/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../models/types.js').ChatInsert} ChatInsert */
/** @typedef {import('../../models/types.js').ChatFile} ChatFile */
/** @typedef {import('../../models/types.js').CatalogAgent} CatalogAgent */
/** @typedef {import('../../models/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../../models/types.js').ComposerState} ComposerState */
/** @typedef {import('../../models/types.js').PermissionRequest} PermissionRequest */
/** @typedef {import('../../models/types.js').SessionNotice} SessionNotice */
/** @typedef {import('@symblight/chat').ChxChat} ChxChat */

/**
 * The composer's ProseMirror document, as far as code goes in: `line+`, each line text and chips.
 * `chx-textbox` and its editor aren't exported by `@symblight/chat`, so typed here.
 * @typedef {{ content: { size: number }, childCount: number, child: (index: number) => PmNode }} PmNode
 * @typedef {Object} PmSchema
 * @property {{ line: PmNodeType, chip: PmNodeType }} nodes
 * @property {(text: string) => PmNode} text
 * @typedef {{ create: (attrs: object | null, content?: PmNode[]) => PmNode }} PmNodeType
 * @typedef {{ doc: PmNode, insert: (pos: number, nodes: PmNode[]) => PmTransaction,
 *   replaceWith: (from: number, to: number, nodes: PmNode[]) => PmTransaction }} PmTransaction
 * @typedef {{ state: { schema: PmSchema, selection: { from: number, to: number }, tr: PmTransaction },
 *   dispatch: (tr: PmTransaction) => void }} PmView
 * @typedef {HTMLElement & { updateComplete: Promise<boolean>, focus: () => void, focusEnd: () => void,
 *   editor?: { view: PmView } }} ComposerTextbox
 */

const SLASH_COMMANDS = ['clear', 'compact', 'init', 'review'];

// Sends arrive as one flat html part; re-split them so chips and pastes keep their own renderers.
const splitOnSend = createSplitOnSendHandler(MESSAGE_PART_RULES);

/**
 * @param {string} value
 * @param {string} headline
 * @param {string} [supportingText]
 */
function buildMenuItem(value, headline, supportingText) {
  const item = createMenuItem();
  item.setAttribute('value', value);
  item.append(headline);
  if (supportingText) {
    const supporting = document.createElement('span');
    supporting.slot = 'supporting-text';
    supporting.textContent = supportingText;
    item.append(supporting);
  }
  return item;
}

/**
 * A file chip naming lines of code: `src/app.js:12`, or `src/app.js:12-23` for several. The label is
 * what the agent reads.
 * @param {PmSchema} schema
 * @param {ChatInsert} insert
 * @param {string | null} root The project's path; the chip names a file inside it relative to it.
 */
function codeChip(schema, { path, fromLine, toLine }, root) {
  const rel = relPath(root, path) ?? path;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const lines = fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;
  return schema.nodes.chip.create({
    templateId: FILE_CHIP_TEMPLATE,
    label: `${rel}:${lines}`,
    icon: fileIconFor(name) ?? fileIcon,
    data: { path: rel, lines },
  });
}

/**
 * A file or folder chip as an `@` pick makes it: its name and icon, the path in `data-path`.
 * @param {string} path Relative to the session's folder, or absolute outside it.
 * @param {boolean} folder
 */
function fileChipAttrs(path, folder) {
  const name = basename(path);
  /** @type {Record<string, string>} */
  const data = folder ? { path, kind: 'folder' } : { path };
  return {
    templateId: FILE_CHIP_TEMPLATE,
    label: name,
    icon: folder ? folderIcon : (fileIconFor(name) ?? fileIcon),
    data,
  };
}

/**
 * A comment's composer lines: its chip, then the comment; the comment's further lines follow as plain lines.
 * @param {PmSchema} schema
 * @param {ChatInsert} insert
 * @param {string | null} root
 */
function commentLines(schema, insert, root) {
  const [first, ...rest] = insert.body.split('\n');
  return [
    schema.nodes.line.create(null, [codeChip(schema, insert, root), schema.text(` ${first}`)]),
    ...rest.map((text) => schema.nodes.line.create(null, text ? [schema.text(text)] : [])),
  ];
}

/**
 * Text with matched characters in `<b>`.
 * @param {string} text
 * @param {Set<number>} hits Code point indices to highlight.
 * @param {number} offset Index of `text`'s first code point within the full path.
 */
function highlight(text, hits, offset) {
  const fragment = document.createDocumentFragment();
  Array.from(text).forEach((ch, i) => {
    fragment.append(hits.has(offset + i) ? Object.assign(document.createElement('b'), { textContent: ch }) : ch);
  });
  return fragment;
}

/** A picker's option; its density comes from src/styles/shadow.css, like every menu's. */
function createMenuItem() {
  return document.createElement('md-menu-item');
}

/**
 * @param {string} svg
 * @param {string} slot
 */
function buildIcon(svg, slot) {
  const icon = document.createElement('md-icon');
  icon.slot = slot;
  icon.innerHTML = svg;
  return icon;
}

/** The `@` menu's first step: picking it opens the file and folder search. */
function buildBrowseItem() {
  const item = createMenuItem();
  item.setAttribute('value', '');
  item.dataset.browse = '';
  item.append(buildIcon(fileIcon, 'leading'), 'Files and Folders', buildIcon(chevronIcon, 'trailing'));
  return item;
}

/**
 * `@` option for a file or folder on one line: its icon, the name, and the folder it's in, matches
 * highlighted (as in Quick Open).
 * @param {QuickOpenItem} entry
 */
function buildEntryItem(entry) {
  const hits = new Set(entry.indices);
  const nameStart = Array.from(entry.path).length - Array.from(entry.name).length;
  const dir = nameStart > 0 ? entry.path.slice(0, entry.path.length - entry.name.length - 1) : '';
  const item = createMenuItem();
  item.setAttribute('value', entry.path);
  item.title = entry.path;
  if (entry.isDir) item.dataset.kind = 'folder';
  const icon = entry.isDir ? folderIcon : (fileIconFor(entry.name) ?? fileIcon);
  item.append(buildIcon(icon, 'leading'), highlight(entry.name, hits, nameStart));
  if (dir) {
    const trailing = document.createElement('span');
    trailing.slot = 'trailing';
    trailing.append(highlight(dir, hits, 0));
    item.append(trailing);
  }
  return item;
}

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
    /** @type {import('../../models/types.js').AgentOptionsStatus | null} */
    this.optionsStatus = null;
    /** @type {readonly string[]} */
    this.branches = [];
    /** @type {string | null} */
    this.currentBranch = null;
    /** @type {number} Other local sessions of the project with a running agent, for the run target. */
    this.localShared = 0;
    /** @type {import('../../models/types.js').LocalTurns} */
    this.localTurns = 'queue';
    /** @type {PermissionRequest | null} */
    this.permission = null;
    /** @type {SessionNotice | null} */
    this.notice = null;
    /** @type {import('../../models/types.js').SignInRun | null} The sign-in of the notice's agent. */
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

  /** The `@` query being typed, `null` when none is. */
  #fileQuery = /** @type {string | null} */ (null);
  /** Whether "Files and Folders" was picked for this `@`: then the query searches. */
  #browsing = false;
  /** Whether the option being resolved is a folder; `chx-command-picked` only carries its value. */
  #pickingFolder = false;

  /** `@` menu: "Files and Folders" until it's picked or a name is typed, then files and folders by name. */
  #onFileQuery = (/** @type {Event} */ e) => {
    const picker = /** @type {ChxCommandPicker} */ (e.target);
    this.#fileQuery = /** @type {CustomEvent<{ value: string | null }>} */ (e).detail.value;
    if (this.#fileQuery === null) this.#browsing = false;
    this.#showFileOptions(picker);
  };

  /** Whether the `@` menu shows search results, rather than nothing or "Files and Folders". */
  get #searching() {
    return this.#fileQuery !== null && (this.#browsing || this.#fileQuery !== '');
  }

  /** @param {ChxCommandPicker} picker */
  #showFileOptions(picker) {
    const query = this.#fileQuery;
    if (!this.#searching) {
      this.#emit('acp-chat-file-query', { query: null });
      picker.clearOptions();
      if (query === null) return;
      const options = document.createDocumentFragment();
      options.append(buildBrowseItem());
      picker.addOptions(options);
      return;
    }
    this.#emit('acp-chat-file-query', { query });
  }

  /** @param {Map<string, unknown>} changed */
  updated(changed) {
    if (!changed.has('fileOptions') || !this.#searching) return;
    const picker = /** @type {ChxCommandPicker | null} */ (this.renderRoot.querySelector('#acp-chat-files'));
    if (!picker) return;
    picker.clearOptions();
    const options = document.createDocumentFragment();
    for (const item of this.fileOptions.slice(0, 50)) options.append(buildEntryItem(item));
    picker.addOptions(options);
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Replaces the `@` picker's `resolve`: "Files and Folders" opens the search instead of
   * inserting a chip.
   * @param {MenuItemElement} option
   */
  #resolveFile = (option) => {
    const picker = /** @type {ChxCommandPicker} */ (this.renderRoot.querySelector('#acp-chat-files'));
    if (option.dataset.browse === undefined) {
      this.#pickingFolder = option.dataset.kind === 'folder';
      ChxCommandPicker.prototype.resolve.call(picker, option);
      return;
    }
    this.#browsing = true;
    this.#showFileOptions(picker);
    // A click on the option moved focus into the menu; keep typing in the composer.
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('chx-message-composer'))?.focus();
  };

  /** Turns a picked file or folder into a chip with its name and icon, the path in `data-path`. */
  #onFilePicked = (/** @type {Event} */ e) => {
    const { value, setChip } = /** @type {CustomEvent<{ value: string, setChip: (chip: HTMLElement) => void }>} */ (e)
      .detail;
    setChip(buildChipElement(fileChipAttrs(value, this.#pickingFolder)));
  };

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
            .resolve=${this.#resolveFile}
            @chx-command-query=${this.#onFileQuery}
            @chx-command-picked=${this.#onFilePicked}
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
