import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { buildChipElement, chipPartRule, createSplitOnSendHandler } from '@symblight/chat';
import '@symblight/chat/composer';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/icon';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import { quickOpen } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import styles from './acp-chat.css?inline';

/** @typedef {import('@symblight/chat').ChxChat} ChxChat */
/** @typedef {import('@symblight/chat/composer').ChxAttachments} ChxAttachments */
/** @typedef {import('@symblight/chat/composer').ChxCodeBlock} ChxCodeBlock */
/** @typedef {import('@symblight/chat/composer').ChxCommandPicker} ChxCommandPicker */
/** @typedef {NonNullable<ChxChat['partElements']>} PartElements */

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
  const item = document.createElement('md-menu-item');
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

/** @param {string} path Relative, `/`-separated. */
function dirname(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
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

  /** `@` search over the project's files. */
  #onFileQuery = async (/** @type {Event} */ e) => {
    const picker = /** @type {ChxCommandPicker} */ (e.target);
    const query = /** @type {CustomEvent<{ value: string | null }>} */ (e).detail.value;
    const rootId = projectController.rootId;
    if (query === null || rootId === null) {
      picker.clearOptions();
      return;
    }
    const { items, cancelled } = await quickOpen(rootId, query);
    if (cancelled) return;
    picker.clearOptions();
    const options = document.createDocumentFragment();
    for (const item of items.slice(0, 50)) options.append(buildMenuItem(item.path, item.name, dirname(item.path)));
    picker.addOptions(options);
  };

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
        <chx-message-list slot="message-list"></chx-message-list>
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
            @chx-command-query=${this.#onFileQuery}
          ></chx-command-picker>
          <chx-command-picker
            id="acp-chat-commands"
            slot="command-field"
            commandCharacter="/"
            @chx-command-query=${this.#onCommandQuery}
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
