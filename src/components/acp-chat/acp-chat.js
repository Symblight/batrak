import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { buildChipElement, chipPartRule, createSplitOnSendHandler } from '@symblight/chat';
import { ChxCommandPicker } from '@symblight/chat/composer';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
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

/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {import('@symblight/chat/composer').ChxAttachments} ChxAttachments */
/** @typedef {import('@symblight/chat/composer').ChxCodeBlock} ChxCodeBlock */
/** @typedef {Parameters<ChxCommandPicker['resolve']>[0]} MenuItemElement */
/** @typedef {NonNullable<ChxChat['partElements']>} PartElements */
/** @typedef {import('../../models/types.js').QuickOpenItem} QuickOpenItem */

const SLASH_COMMANDS = ['clear', 'compact', 'init', 'review'];

/** Matches the paste chip `chx-paste-long-text` serializes; code pastes carry `data-lang`. */
const codePartRule = {
  type: 'code',
  selector: 'span[data-paste-lines][data-lang]',
  toPart: (/** @type {HTMLElement} */ element) => ({
    text: element.textContent ?? '',
    lang: element.dataset.lang ?? '',
  }),
};

const longTextPartRule = {
  type: 'longText',
  selector: 'span[data-paste-lines]:not([data-lang])',
  toPart: (/** @type {HTMLElement} */ element) => ({
    text: element.textContent ?? '',
    lines: Number(element.dataset.pasteLines) || 0,
  }),
};

// Sends arrive as one flat html part; re-split them so chips and pastes keep their own renderers.
const splitOnSend = createSplitOnSendHandler([chipPartRule, codePartRule, longTextPartRule]);

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

/** Chip template ids: file chips carry the path in `data-path`, folder chips also `data-kind="folder"`. */
const FILE_CHIP_TEMPLATE = 'acp-chat-file-chip';
const COMMAND_CHIP_TEMPLATE = 'acp-chat-command-chip';

/**
 * Adds the chip templates to `document` once. The composer draws every chip with `buildChipElement`,
 * which finds its template by `document.getElementById`: one inside this shadow root (like the
 * pickers' own) is never found, and the chip falls back to a bare span that sends as plain text.
 */
function ensureChipTemplates() {
  if (document.getElementById(FILE_CHIP_TEMPLATE)) return;
  const file = document.createElement('template');
  file.id = FILE_CHIP_TEMPLATE;
  file.innerHTML = `<chx-chip data-template-id="${FILE_CHIP_TEMPLATE}"><md-icon slot="icon"></md-icon></chx-chip>`;
  const command = document.createElement('template');
  command.id = COMMAND_CHIP_TEMPLATE;
  command.innerHTML = `<chx-chip data-template-id="${COMMAND_CHIP_TEMPLATE}"></chx-chip>`;
  document.body.append(file, command);
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

/**
 * Compact sizes for the pickers' menus. Set inline: `md-menu` / `md-menu-item` declare their own
 * defaults on `:host`, so inherited values lose, and both live in the picker's shadow root.
 */
const COMPACT_MENU = {
  '--md-menu-min-width': '10rem',
  '--md-menu-shape': 'var(--md-sys-shape-corner-medium, 0.75rem)',
};
const COMPACT_ITEM = {
  '--md-menu-item-min-block-size': '1.75rem',
  '--md-menu-item-padding-block': '0.125rem',
  '--md-menu-item-padding-inline': '0.5rem',
  '--md-menu-item-leading-icon-size': '1rem',
  '--md-menu-item-trailing-icon-size': '1rem',
  '--md-menu-item-label-text-size': '0.8125rem',
  '--md-menu-item-label-text-weight': '400',
  '--md-menu-item-trailing-text-size': '0.75rem',
  'margin-inline': '0.25rem',
};

/**
 * @param {HTMLElement} element
 * @param {Record<string, string>} properties
 */
function setStyles(element, properties) {
  for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value);
  return element;
}

/** @returns {HTMLElement} */
function createMenuItem() {
  return setStyles(document.createElement('md-menu-item'), COMPACT_ITEM);
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

/** @type {{ id: string, label: string }[]} */
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/**
 * @tag acp-chat
 * @summary Agent chat: message list plus a composer with `@` file mentions, `/` commands, attachments, paste chips and a model picker.
 * @fires acp-model-change `{ model }`
 */
export class AcpChat extends LitElement {
  static properties = {
    model: {},
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} Model id, one of `MODELS`. */
    this.model = MODELS[0].id;
  }

  connectedCallback() {
    super.connectedCallback();
    ensureChipTemplates();
  }

  async firstUpdated() {
    for (const picker of /** @type {NodeListOf<ChxCommandPicker>} */ (this.renderRoot.querySelectorAll('chx-command-picker'))) {
      await picker.updateComplete;
      setStyles(picker.menuElement, COMPACT_MENU);
    }
  }

  /** @type {PartElements} */
  #partElements = {
    chip: (part) => buildChipElement(/** @type {Parameters<typeof buildChipElement>[0]} */ (part)),
    code: (part, previous) => {
      const block = /** @type {ChxCodeBlock} */ (previous ?? document.createElement('chx-code-block'));
      block.code = part.text ?? '';
      block.lang = /** @type {{ lang?: string }} */ (part).lang ?? '';
      block.copyable = true;
      return block;
    },
    longText: (part, previous) => {
      const details = previous ?? document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${/** @type {{ lines?: number }} */ (part).lines ?? 0} lines`;
      const pre = document.createElement('pre');
      pre.textContent = part.text ?? '';
      details.replaceChildren(summary, pre);
      return details;
    },
    attachment: (part, previous) => {
      const file = /** @type {File} */ (part.attachment);
      if (previous && /** @type {HTMLElement & { file?: File }} */ (previous).file === file) return previous;
      const card = this.#attachments.buildAttachment(file, 'message');
      // An empty `actions` slot drops the remove button: a sent card is immutable.
      card.append(Object.assign(document.createElement('span'), { slot: 'actions' }));
      return card;
    },
  };

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

  /** @param {Event} e */
  #onModelSelect(e) {
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (value === this.model) return;
    this.model = value;
    this.dispatchEvent(new CustomEvent('acp-model-change', { detail: { model: value }, bubbles: true, composed: true }));
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
    const current = MODELS.find((m) => m.id === this.model) ?? MODELS[0];
    return html`
      <chx-chat
        class="acp-chat__chat"
        .userId=${'me'}
        .partElements=${this.#partElements}
        @chx-messages-change=${this.#onMessagesChange}
      >
        <chx-message-list
          slot="message-list"
          scroll-behavior="smooth"
          content-align="start"
          scroll-mode="pin-top"
        >
          <chx-streaming-indicator slot="streaming"></chx-streaming-indicator>
          <chx-scroll-to-bottom-affordance slot="scroll-to-bottom"></chx-scroll-to-bottom-affordance>
        </chx-message-list>
        <chx-message-composer  slot="message-composer" placeholder="Write your prompt...">
          <md-icon-button slot="leading" aria-label="Attach files" @click=${() => this.#attachments.open()}>
            <md-icon class="acp-chat__attach-icon">${unsafeSVG(addIcon)}</md-icon>
          </md-icon-button>
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
          <md-button id="acp-chat-model" slot="actions" variant="text" aria-haspopup="menu">
            ${current.label}
          </md-button>
        </chx-message-composer>
      </chx-chat>
      <md-menu for="acp-chat-model" placement="top-end" @select=${this.#onModelSelect}>
        ${MODELS.map(
          (m) => html`<md-menu-item value=${m.id} ?selected=${m.id === this.model}>${m.label}</md-menu-item>`,
        )}
      </md-menu>
    `;
  }
}

customElements.define('acp-chat', AcpChat);
