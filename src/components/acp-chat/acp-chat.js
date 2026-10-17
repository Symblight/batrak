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
import { quickOpen } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import styles from './acp-chat.css?inline';
import { reportError } from '../../services/notices.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $chatInserts, takeChatInserts } from '../../stores/chat.js';
import { ChatSessionController } from '../../controllers/chat-session/ChatSessionController.js';
import {
  COMMAND_CHIP_TEMPLATE,
  ChatPartsController,
  FILE_CHIP_TEMPLATE,
} from '../../controllers/chat-parts/ChatPartsController.js';
import { USER_ID, acpAdapter } from '../../services/acp-adapter.js';
import { MESSAGE_PART_RULES } from '../../models/chat-parts.js';
import '../acp-agent-picker/acp-agent-picker.js';
import '../acp-context-meter/acp-context-meter.js';
import '../acp-mode-picker/acp-mode-picker.js';
import '../acp-run-target/acp-run-target.js';
import '../acp-session-banner/acp-session-banner.js';

/** @typedef {import('@symblight/chat/composer').ChxAttachments} ChxAttachments */
/** @typedef {Parameters<ChxCommandPicker['resolve']>[0]} MenuItemElement */
/** @typedef {import('../../models/types.js').QuickOpenItem} QuickOpenItem */
/** @typedef {import('../../models/types.js').ChatInsert} ChatInsert */

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
 */
function codeChip(schema, { path, fromLine, toLine }) {
  const rel = projectController.relPath(path) ?? path;
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
 * A comment's composer lines: its chip, then the comment; the comment's further lines follow as plain lines.
 * @param {PmSchema} schema
 * @param {ChatInsert} insert
 */
function commentLines(schema, insert) {
  const [first, ...rest] = insert.body.split('\n');
  return [
    schema.nodes.line.create(null, [codeChip(schema, insert), schema.text(` ${first}`)]),
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
 * @fires acp-file-open `{ path, line }` when a file chip or link in a message, or a tool call's location, is clicked
 * @fires acp-file-reveal `{ path }` when a folder chip or link in a message is clicked
 */
export class AcpChat extends LitElement {
  static styles = styles;

  #session = new ChatSessionController(this, { chat: () => this.renderRoot.querySelector('chx-chat') });

  #parts = new ChatPartsController(this, { attachments: () => this.#attachments });

  /** Code sent from the editors (selections, `<acp-comment-bar>`'s comments) goes into the composer. */
  #chatInserts = new StoreController(this, {
    store: $chatInserts,
    onChange: (inserts) => {
      if (inserts.length) this.#insertCode();
    },
  });

  /**
   * Takes `$chatInserts` into the composer: a selection's chip at the caret, a comment as its own line
   * after the draft (replacing an empty one).
   */
  async #insertCode() {
    await this.updateComplete;
    const composer = /** @type {import('lit').LitElement | null} */ (this.renderRoot.querySelector('chx-message-composer'));
    await composer?.updateComplete;
    const textbox = /** @type {ComposerTextbox | null} */ (composer?.renderRoot.querySelector('chx-textbox') ?? null);
    await textbox?.updateComplete;
    const view = textbox?.editor?.view;
    if (!textbox || !view) return; // they wait in the store
    const inserts = takeChatInserts();
    if (!inserts.length) return;
    const { schema, selection } = view.state;
    let tr = view.state.tr;
    const chips = inserts.filter((i) => !i.body).flatMap((i) => [codeChip(schema, i), schema.text(' ')]);
    if (chips.length) tr = tr.replaceWith(selection.from, selection.to, chips);
    const lines = inserts.filter((i) => i.body).flatMap((i) => commentLines(schema, i));
    if (lines.length) {
      const { doc } = tr;
      const empty = doc.childCount === 1 && doc.child(0).content.size === 0;
      tr = empty ? tr.replaceWith(0, doc.content.size, lines) : tr.insert(doc.content.size, lines);
    }
    view.dispatch(tr);
    if (lines.length) textbox.focusEnd();
    else textbox.focus(); // the caret stays after the chips
  }

  /** Rendered unconditionally, so present after the first render. */
  get #attachments() {
    return /** @type {ChxAttachments} */ (this.renderRoot.querySelector('chx-attachments'));
  }

  /** @param {Event} e */
  #onMessagesChange(e) {
    splitOnSend(/** @type {Parameters<typeof splitOnSend>[0]} */ (e));
  }

  /** Sequence of `@` queries; only the latest answer is shown. */
  #fileQueryId = 0;
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

  /** @param {ChxCommandPicker} picker */
  async #showFileOptions(picker) {
    const id = ++this.#fileQueryId;
    const query = this.#fileQuery;
    const rootId = projectController.rootId;
    if (query === null) {
      picker.clearOptions();
      return;
    }
    if (!this.#browsing && query === '') {
      const options = document.createDocumentFragment();
      options.append(buildBrowseItem());
      picker.clearOptions();
      picker.addOptions(options);
      return;
    }
    if (rootId === null) {
      picker.clearOptions();
      return;
    }
    try {
      const { items, cancelled } = await quickOpen(rootId, query, true);
      if (id !== this.#fileQueryId || cancelled) return;
      picker.clearOptions();
      const options = document.createDocumentFragment();
      for (const item of items.slice(0, 50)) options.append(buildEntryItem(item));
      picker.addOptions(options);
    } catch (err) {
      reportError('File search failed', err);
    }
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
    const isDir = this.#pickingFolder;
    const name = value.slice(value.lastIndexOf('/') + 1);
    setChip(
      buildChipElement({
        templateId: FILE_CHIP_TEMPLATE,
        label: name,
        icon: isDir ? folderIcon : (fileIconFor(name) ?? fileIcon),
        data: isDir ? { path: value, kind: 'folder' } : { path: value },
      }),
    );
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
    const empty = this.#session.empty;
    return html`
      <chx-chat
        class=${classMap({ 'acp-chat__chat': true, 'acp-chat__chat_empty': empty })}
        .userId=${USER_ID}
        .activeConversationId=${this.#session.conversationId}
        .adapter=${acpAdapter}
        .partElements=${this.#parts.partElements}
        @chx-messages-change=${this.#onMessagesChange}
      >
        <chx-message-list
          slot="message-list"
          class="acp-chat__message-list"
          ?hidden=${empty}
          scroll-behavior="smooth"
          content-align="start"
          scroll-mode="pin-top"
        >
          <chx-streaming-indicator slot="streaming"></chx-streaming-indicator>
          <chx-scroll-to-bottom-affordance slot="scroll-to-bottom"></chx-scroll-to-bottom-affordance>
        </chx-message-list>
        <acp-session-banner slot="input-banner" class="acp-chat__banner"></acp-session-banner>
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
          <acp-agent-picker slot="leading" class="acp-chat__agent-picker"></acp-agent-picker>
          <chx-attachments slot="attachments"></chx-attachments>
          <chx-paste-long-text></chx-paste-long-text>
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
          <acp-mode-picker slot="actions"></acp-mode-picker>
          <acp-context-meter slot="actions"></acp-context-meter>
          <!-- Where the session runs is picked before the first message; the footer goes with it. -->
          ${empty ? html`<acp-run-target slot="footer" class="acp-chat__run-target"></acp-run-target>` : nothing}
        </chx-message-composer>
      </chx-chat>
    `;
  }
}

customElements.define('acp-chat', AcpChat);
