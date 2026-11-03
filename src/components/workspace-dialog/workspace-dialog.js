import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/text-field';
import '../agent-icon/agent-icon.js';
import '../shortcut/shortcut.js';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import branchIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import { app } from '../../hooks/app/app.js';
import { slugPreview } from '../../hooks/workspaces/rules.js';
import styles from './workspace-dialog.css?inline';

/** @typedef {Pick<import('../../hooks/agents/types.js').AgentSummary, 'id' | 'name'>} AgentChoice */

const BASE_ID = 'acp-workspace-dialog-base';
const AGENT_ID = 'acp-workspace-dialog-agent';

/**
 * @tag acp-workspace-dialog
 * @summary New workspace: an optional name (the agent names it otherwise) with the branch it gets, the branch it's based on, the agent of its first chat; Create (or Mod+Enter) works at once.
 * @fires acp-workspace-create `{ name, baseBranch, agentId }` `name` is `null` when none was typed.
 * @fires acp-branches-query `{}` As it opens; answered through `branches`.
 */
export class AcpWorkspaceDialog extends LitElement {
  static properties = {
    branches: { attribute: false },
    currentBranch: { attribute: false },
    baseBranch: { attribute: false },
    taken: { attribute: false },
    agents: { attribute: false },
    agentId: { attribute: false },
    name: { state: true },
    base: { state: true },
    agent: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly string[]} The project's local branches. */
    this.branches = [];
    /** @type {string | null} The shown folder's checked-out branch. */
    this.currentBranch = null;
    /** @type {string | null} The project's base branch: the default. */
    this.baseBranch = null;
    /** @type {readonly string[]} Branches its workspaces have. */
    this.taken = [];
    /** @type {readonly AgentChoice[]} */
    this.agents = [];
    /** @type {string | null} The project's default agent. */
    this.agentId = null;
    /** @type {string} */
    this.name = '';
    /** @type {string | null} */
    this.base = null;
    /** @type {string | null} */
    this.agent = null;
  }

  get #dialog() {
    return /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog'));
  }

  /** Opens it with everything prefilled. */
  async show() {
    this.name = '';
    this.base = this.baseBranch ?? this.currentBranch;
    this.agent = this.agentId;
    this.dispatchEvent(new CustomEvent('acp-branches-query', { detail: {}, bubbles: true, composed: true }));
    await this.updateComplete;
    await this.#dialog.show();
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-workspace-dialog__name'))?.focus();
  }

  #close() {
    void this.#dialog.close();
  }

  #create() {
    const name = this.name.trim();
    this.dispatchEvent(
      new CustomEvent('acp-workspace-create', {
        detail: { name: name === '' ? null : name, baseBranch: this.base, agentId: this.agent },
        bubbles: true,
        composed: true,
      }),
    );
    this.#close();
  }

  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    const mod = app.platform === 'mac' ? e.metaKey : e.ctrlKey;
    if (e.key !== 'Enter' || !mod) return;
    e.preventDefault();
    this.#create();
  };

  /**
   * A read-only field opens its menu from the keyboard too.
   * @param {KeyboardEvent} e
   */
  #onPickerKeydown(e) {
    if (e.metaKey || e.ctrlKey || !['ArrowDown', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    const field = /** @type {HTMLElement} */ (e.currentTarget);
    void /** @type {HTMLElementTagNameMap['md-menu'] | null} */ (this.renderRoot.querySelector(`md-menu[for="${field.id}"]`))?.show();
  }

  /** The current branch first, then the base, then the rest. */
  get #branchOptions() {
    const first = /** @type {string[]} */ ([this.currentBranch, this.baseBranch, this.base].filter((b) => b !== null));
    return [...new Set([...first, ...this.branches])];
  }

  /** @param {string | null} branch */
  #branchNote(branch) {
    if (branch !== null && branch === this.baseBranch) return 'Project base branch';
    if (branch !== null && branch === this.currentBranch) return 'Current branch';
    return '';
  }

  /**
   * A read-only outlined field with a leading icon that opens a menu of `options`.
   * @param {string} id
   * @param {string} label
   * @param {string} value Its text.
   * @param {unknown} leading
   * @param {readonly { value: string, label: string, leading: unknown }[]} options
   * @param {string | null} selected
   * @param {(value: string) => void} onPick
   */
  #renderPicker(id, label, value, leading, options, selected, onPick) {
    return html`<md-text-field
        id=${id}
        class="acp-workspace-dialog__field acp-workspace-dialog__picker"
        variant="outlined"
        label=${label}
        readonly
        .value=${value}
        @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onPickerKeydown(e)}
      >
        <span slot="leading" class="acp-workspace-dialog__leading">${leading}</span>
        <md-icon slot="trailing" class="acp-workspace-dialog__icon">${unsafeSVG(arrowIcon)}</md-icon>
      </md-text-field>
      <md-menu
        class="acp-workspace-dialog__menu"
        for=${id}
        placement="bottom-start"
        focus-on-open="selected"
        match-anchor-width
        aria-label=${label}
        @select=${(/** @type {CustomEvent<{ value: string }>} */ e) => {
          if (e.target === e.currentTarget) onPick(e.detail.value);
        }}
      >
        ${options.map(
          (o) => html`<md-menu-item value=${o.value} ?selected=${o.value === selected}>
            <span slot="leading" class="acp-workspace-dialog__leading">${o.leading}</span>
            ${o.label}
          </md-menu-item>`,
        )}
      </md-menu>`;
  }

  render() {
    const name = this.name.trim();
    const branch = html`<md-icon class="acp-workspace-dialog__icon">${unsafeSVG(branchIcon)}</md-icon>`;
    const agent = this.agents.find((a) => a.id === this.agent) ?? null;
    /** @param {AgentChoice} a */
    const agentIcon = (a) => html`<acp-agent-icon class="acp-workspace-dialog__icon" .agent=${a}></acp-agent-icon>`;
    const mac = app.platform === 'mac';
    return html`<md-dialog class="acp-workspace-dialog__dialog" @keydown=${this.#onKeydown}>
      <div slot="headline" class="acp-workspace-dialog__head">
        <h2 class="acp-workspace-dialog__headline">New workspace</h2>
        <p class="acp-workspace-dialog__subtitle">Own folder and branch. The first chat opens right away.</p>
      </div>
      <div class="acp-workspace-dialog__content">
        <div class="acp-workspace-dialog__row">
          <md-text-field
            class="acp-workspace-dialog__field acp-workspace-dialog__name"
            variant="outlined"
            label="Name"
            spellcheck="false"
            .value=${this.name}
            @input=${(/** @type {Event} */ e) => (this.name = /** @type {HTMLInputElement} */ (e.target).value)}
          ></md-text-field>
          <span class="acp-workspace-dialog__note">
            ${name
              ? html`Branch <span class="acp-workspace-dialog__branch">${slugPreview(name, this.taken)}</span>`
              : html`Optional: the agent names it from your first message · branch <span class="acp-workspace-dialog__mono">brama/…</span>`}
          </span>
        </div>
        <div class="acp-workspace-dialog__row">
          ${this.#renderPicker(
            BASE_ID,
            'Based on',
            this.base ?? '',
            branch,
            this.#branchOptions.map((b) => ({ value: b, label: b, leading: branch })),
            this.base,
            (value) => (this.base = value),
          )}
          <span class="acp-workspace-dialog__note">${this.#branchNote(this.base)}</span>
        </div>
        <div class="acp-workspace-dialog__row">
          ${this.#renderPicker(
            AGENT_ID,
            'Agent',
            agent?.name ?? '',
            agent ? agentIcon(agent) : nothing,
            this.agents.map((a) => ({ value: a.id, label: a.name, leading: agentIcon(a) })),
            this.agent,
            (value) => (this.agent = value),
          )}
          <span class="acp-workspace-dialog__note">${this.agent !== null && this.agent === this.agentId ? 'Project default' : ''}</span>
        </div>
      </div>
      <div slot="footer" class="acp-workspace-dialog__footer">
        <md-button class="acp-workspace-dialog__action acp-workspace-dialog__cancel" variant="text" @click=${() => this.#close()}>Cancel</md-button>
        <md-button class="acp-workspace-dialog__action acp-workspace-dialog__create" variant="filled" @click=${() => this.#create()}>
          <acp-shortcut slot="icon" class="acp-workspace-dialog__key">${mac ? '⌘↵' : 'Ctrl+↵'}</acp-shortcut>
          Create
        </md-button>
      </div>
    </md-dialog>`;
  }
}

customElements.define('acp-workspace-dialog', AcpWorkspaceDialog);
