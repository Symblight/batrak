import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/select';
import '@symblight/wc-material/text-field';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import { commandLine, parseCommandLine } from '../../models/agents/agents.js';
import styles from './agent-form.css?inline';

/** @typedef {import('../../models/types/types.js').KnownAgent} KnownAgent */
/** @typedef {import('../../models/types/types.js').NewAgent} NewAgent */

/**
 * An agent the form edits: what it's called and runs.
 * @typedef {{ id: string, name: string, command: string, args: readonly string[] }} EditedAgent
 */

/**
 * The form: a registry agent (`known`, `''` when it runs another launch) and, when `custom`, the
 * command line typed.
 * @typedef {{ known: string, name: string, custom: boolean, command: string }} Draft
 */

/**
 * @tag acp-agent-form
 * @summary The form to edit an agent: its name, the registry agent it runs, or its own command line.
 * @fires acp-agent-update `{ agentId, agent }` A `NewAgent`; the container answers with `saveFinished()`.
 * @fires acp-agent-remove `{ agentId }` From the edit form.
 * @fires acp-agent-form-close `null` Cancelled, or saved; not composed, for the element that shows it.
 */
export class AcpAgentForm extends LitElement {
  static properties = {
    known: { attribute: false },
    agent: { attribute: false },
    saving: { state: true },
    error: { state: true },
    draft: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly KnownAgent[]} The registry agents to pick from. */
    this.known = [];
    /** @type {EditedAgent | null} The agent edited; `null` shows nothing. */
    this.agent = null;
    /** An `acp-agent-update` waits for `saveFinished()`. */
    this.saving = false;
    /** @type {string | null} Why the last save failed. */
    this.error = null;
    /** @type {Draft} What the form holds. */
    this.draft = { known: '', name: '', custom: true, command: '' };
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    if (changed.has('agent')) this.draft = this.#start();
  }

  firstUpdated() {
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-agent-form__select'))?.focus();
  }

  /** @returns {Draft} The edited agent as it is (its registry agent while it runs that launch). */
  #start() {
    const agent = this.agent;
    if (!agent) return { known: '', name: '', custom: true, command: '' };
    const line = commandLine(agent.command, [...agent.args]);
    const same = this.known.find((k) => commandLine(k.command, k.args) === line);
    const named = same ?? this.known.find((k) => k.id === agent.id);
    return { known: named?.id ?? '', name: agent.name, custom: !same, command: line };
  }

  /** @param {string} id */
  #knownAgent(id) {
    return this.known.find((k) => k.id === id) ?? null;
  }

  /**
   * The container's answer to `acp-agent-update`: `null` closes the form, a message stays on it.
   * @param {string | null} error
   */
  saveFinished(error) {
    this.saving = false;
    this.error = error;
    if (error === null) this.#close();
  }

  #close = () => {
    this.dispatchEvent(new CustomEvent('acp-agent-form-close', { detail: null }));
  };

  get #canSave() {
    const { name, custom, command } = this.draft;
    return !this.saving && name.trim() !== '' && (!custom || parseCommandLine(command).command !== '');
  }

  #save = () => {
    if (!this.#canSave) return;
    const agentId = this.agent?.id;
    const { known, name, custom } = this.draft;
    if (agentId === undefined) return;
    this.saving = true;
    this.error = null;
    /** @type {NewAgent} */
    const agent = { name: name.trim() };
    if (known) agent.known = known;
    if (custom) Object.assign(agent, parseCommandLine(this.draft.command));
    this.#emit('acp-agent-update', { agentId, agent });
  };

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * @param {'name' | 'command'} key
   * @param {Event} e
   */
  #onInput(key, e) {
    this.draft = { ...this.draft, [key]: /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value };
  }

  #onPick = (/** @type {Event} */ e) => {
    const known = this.#knownAgent(/** @type {HTMLElementTagNameMap['md-select']} */ (e.target).value ?? '');
    // The agent keeps its own name.
    if (known) this.draft = { ...this.draft, known: known.id, custom: false, command: commandLine(known.command, known.args) };
  };

  /** Checked: the command is the user's, starting from the registry's; unchecked: the registry's again. */
  #onCustom = (/** @type {Event} */ e) => {
    const custom = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (e.target).checked;
    const known = this.#knownAgent(this.draft.known);
    const command = !custom && known ? commandLine(known.command, known.args) : this.draft.command;
    this.draft = { ...this.draft, custom, command };
  };

  #onKeydown = (/** @type {KeyboardEvent} */ e) => {
    // Enter in the select opens its menu, on the checkbox toggles it.
    if (e.key === 'Enter' && /** @type {Element} */ (e.target).localName === 'md-text-field') {
      e.preventDefault();
      this.#save();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      this.#close();
    }
  };

  render() {
    const { known, name, custom, command } = this.draft;
    const agent = this.agent;
    if (!agent) return nothing;
    return html`<div class="acp-agent-form__form" @keydown=${this.#onKeydown}>
      <span class="acp-agent-form__subtitle">Edit ${agent.name}</span>
      <md-select class="acp-agent-form__input acp-agent-form__select" variant="outlined" label="Agent" .value=${known} @change=${this.#onPick}>
        ${this.known.map((k) => html`<md-option value=${k.id}>${k.name}</md-option>`)}
      </md-select>
      <md-text-field
        class="acp-agent-form__input"
        variant="outlined"
        label="Name"
        spellcheck="false"
        .value=${name}
        @input=${(/** @type {Event} */ e) => this.#onInput('name', e)}
      ></md-text-field>
      <md-text-field
        class="acp-agent-form__input acp-agent-form__input_mono"
        variant="outlined"
        label="Command"
        spellcheck="false"
        autocapitalize="off"
        ?disabled=${!custom}
        .value=${command}
        @input=${(/** @type {Event} */ e) => this.#onInput('command', e)}
      >
        ${custom ? nothing : html`<md-icon slot="trailing-icon" class="acp-agent-form__lock">${unsafeSVG(lockIcon)}</md-icon>`}
      </md-text-field>
      <span class="acp-agent-form__hint"
        >${custom
          ? 'Program and arguments in one line, as in a terminal. Quote arguments with spaces.'
          : 'From the ACP agent registry, pinned to its version. Check the box to change it.'}</span
      >
      <label class="acp-agent-form__check">
        <md-checkbox class="acp-agent-form__custom" ?disabled=${!known} .checked=${custom} @change=${this.#onCustom}></md-checkbox>
        Use custom command
      </label>
      ${this.error ? html`<span class="acp-agent-form__error" role="alert">${this.error}</span>` : nothing}
      <div class="acp-agent-form__actions">
        <md-button
          class="acp-agent-form__button acp-agent-form__button_danger"
          variant="text"
          @click=${() => this.#emit('acp-agent-remove', { agentId: agent.id })}
          >Remove</md-button
        >
        <span class="acp-agent-form__spacer"></span>
        <md-button class="acp-agent-form__button" variant="text" @click=${this.#close}>Cancel</md-button>
        <md-button class="acp-agent-form__button" variant="filled" ?disabled=${!this.#canSave} @click=${this.#save}>Save</md-button>
      </div>
    </div>`;
  }
}

customElements.define('acp-agent-form', AcpAgentForm);
