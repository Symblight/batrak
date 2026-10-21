import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/checkbox';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/select';
import '@symblight/wc-material/switch';
import '@symblight/wc-material/text-field';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import deleteIcon from '@material-design-icons/svg/outlined/delete.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import starIcon from '@material-design-icons/svg/outlined/star.svg?raw';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { agentStatus, commandLine, glyphOf, parseCommandLine } from '../../models/agents.js';
import styles from './acp-settings-agents.css?inline';

/** @typedef {import('../../models/types.js').AgentList} AgentList */
/** @typedef {import('../../models/types.js').AgentSummary} AgentSummary */
/** @typedef {import('../../models/types.js').KnownAgent} KnownAgent */
/** @typedef {import('../../models/types.js').NewAgent} NewAgent */

/**
 * The form: a known agent (`known`, `''` for another) and, when `custom`, the command line typed.
 * @typedef {{ known: string, name: string, custom: boolean, command: string }} Draft
 */

/**
 * @tag acp-settings-agents
 * @summary Settings' Agents section: the configured agents, each with an on/off switch and a menu (Edit, Set as default, Remove), and the form to add or edit an ACP agent (a known one or any command).
 * @fires acp-agent-add `{ agent }` A `NewAgent`; the container answers with `saveFinished()`.
 * @fires acp-agent-update `{ agentId, agent }` A `NewAgent`; the container answers with `saveFinished()`.
 * @fires acp-agent-enable `{ agentId, enabled }`
 * @fires acp-agent-default `{ agentId }`
 * @fires acp-agent-remove `{ agentId }`
 * @fires acp-agents-import `null` Copy the user's own agents into the project.
 */
export class AcpSettingsAgents extends LitElement {
  static properties = {
    agents: { attribute: false },
    adding: { state: true },
    editing: { state: true },
    saving: { state: true },
    error: { state: true },
    draft: { state: true },
    hovered: { state: true },
  };

  static styles = styles;

  /** @type {ContextMenuController<AgentSummary>} */
  #menu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-settings-agents__menu'),
    onSelect: (value, agent) => this.#onMenuSelect(value, agent),
  });

  constructor() {
    super();
    /** @type {AgentList | null} */
    this.agents = null;
    /** Whether the add form is open. */
    this.adding = false;
    /** @type {string | null} The agent whose edit form is open, in place of its row. */
    this.editing = null;
    /** An `acp-agent-add` / `-update` waits for `saveFinished()`. */
    this.saving = false;
    /** @type {string | null} Why the last save failed. */
    this.error = null;
    /** @type {Draft} What the form holds. */
    this.draft = { known: '', name: '', custom: true, command: '' };
    /** @type {string | null} The row under the pointer or holding focus: it shows its menu button. */
    this.hovered = null;
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    // agents.json no longer has the agent being edited (removed in the file, or from another window).
    if (changed.has('agents') && this.editing && !this.agents?.agents.some((a) => a.id === this.editing)) this.#close();
  }

  /** @param {string} id */
  #known(id) {
    return this.agents?.known.find((k) => k.id === id) ?? null;
  }

  /**
   * The form with a known agent picked (`''`: another agent, any command), its own command shown.
   * @param {string} id
   * @returns {Draft}
   */
  #pick(id) {
    const known = this.#known(id);
    return known
      ? { known: known.id, name: known.name, custom: false, command: commandLine(known.command, known.args) }
      : { known: '', name: '', custom: true, command: '' };
  }

  /** Opens the add form on the first known agent not configured yet, focused. */
  async startAdding() {
    if (!this.adding) {
      const { agents = [], known = [] } = this.agents ?? {};
      const next = known.find((k) => !agents.some((a) => a.id === k.id));
      this.adding = true;
      this.editing = null;
      this.error = null;
      this.draft = this.#pick(next?.id ?? '');
    }
    await this.#focusForm();
  }

  /**
   * Opens the edit form in place of the agent's row: its registry agent while it runs that launch,
   * else its command line.
   * @param {AgentSummary} agent
   */
  async #startEditing(agent) {
    const line = commandLine(agent.command, agent.args);
    const known = this.agents?.known ?? [];
    const same = known.find((k) => commandLine(k.command, k.args) === line);
    const named = same ?? known.find((k) => k.id === agent.id);
    this.adding = false;
    this.editing = agent.id;
    this.error = null;
    this.draft = { known: named?.id ?? '', name: agent.name, custom: !same, command: line };
    await this.#focusForm();
  }

  async #focusForm() {
    await this.updateComplete;
    /** @type {HTMLElement | null} */ (this.renderRoot.querySelector('.acp-settings-agents__select'))?.focus();
  }

  /**
   * The container's answer to `acp-agent-add` / `-update`: `null` closes the form, a message stays on it.
   * @param {string | null} error
   */
  saveFinished(error) {
    this.saving = false;
    this.error = error;
    if (error === null) this.#close();
  }

  #close = () => {
    this.adding = false;
    this.editing = null;
    this.error = null;
  };

  get #canSave() {
    const { name, custom, command } = this.draft;
    return !this.saving && name.trim() !== '' && (!custom || parseCommandLine(command).command !== '');
  }

  #save = () => {
    if (!this.#canSave) return;
    const { known, name, custom } = this.draft;
    this.saving = true;
    this.error = null;
    /** @type {NewAgent} */
    const agent = { name: name.trim() };
    if (known) agent.known = known;
    if (custom) Object.assign(agent, parseCommandLine(this.draft.command));
    if (this.editing) this.#emit('acp-agent-update', { agentId: this.editing, agent });
    else this.#emit('acp-agent-add', { agent });
  };

  /** @param {string} agentId */
  #remove(agentId) {
    if (this.editing === agentId) this.#close();
    this.#emit('acp-agent-remove', { agentId });
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * @param {string} value
   * @param {AgentSummary} agent
   */
  #onMenuSelect(value, agent) {
    if (value === 'edit') this.#startEditing(agent);
    else if (value === 'default') this.#emit('acp-agent-default', { agentId: agent.id });
    else if (value === 'remove') this.#remove(agent.id);
  }

  /**
   * @param {'name' | 'command'} key
   * @param {Event} e
   */
  #onInput(key, e) {
    this.draft = { ...this.draft, [key]: /** @type {HTMLElementTagNameMap['md-text-field']} */ (e.target).value };
  }

  #onPick = (/** @type {Event} */ e) => {
    const picked = this.#pick(/** @type {HTMLElementTagNameMap['md-select']} */ (e.target).value ?? '');
    // An edit keeps the agent's own name.
    this.draft = this.editing ? { ...picked, name: this.draft.name } : picked;
  };

  /** Checked: the command is the user's, starting from the registry's; unchecked: the registry's again. */
  #onCustom = (/** @type {Event} */ e) => {
    const custom = /** @type {HTMLElementTagNameMap['md-checkbox']} */ (e.target).checked;
    const known = this.#known(this.draft.known);
    const command = !custom && known ? commandLine(known.command, known.args) : this.draft.command;
    this.draft = { ...this.draft, custom, command };
  };

  #onFormKeydown = (/** @type {KeyboardEvent} */ e) => {
    // Enter in the select opens its menu, on the checkbox toggles it.
    if (e.key === 'Enter' && /** @type {Element} */ (e.target).localName === 'md-text-field') {
      e.preventDefault();
      this.#save();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      this.#close();
    }
  };

  /**
   * @param {AgentSummary} agent
   * @param {boolean} isDefault
   */
  #renderRow(agent, isDefault) {
    const status = agentStatus(agent);
    const showMore = this.hovered === agent.id || this.#menu.target?.id === agent.id;
    return html`<li
      class="acp-settings-agents__row"
      @pointerenter=${() => (this.hovered = agent.id)}
      @pointerleave=${() => (this.hovered = null)}
      @focusin=${() => (this.hovered = agent.id)}
      @focusout=${(/** @type {FocusEvent} */ e) => {
        if (!(/** @type {Node} */ (e.currentTarget).contains(/** @type {Node | null} */ (e.relatedTarget)))) this.hovered = null;
      }}
      @contextmenu=${(/** @type {MouseEvent} */ e) => this.#menu.onContextMenu(agent, e)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#menu.onKeydown(agent, e)}
    >
      <span class=${classMap({ 'acp-settings-agents__glyph': true, 'acp-settings-agents__glyph_off': !agent.enabled })} aria-hidden="true"
        >${glyphOf(agent.name)}</span
      >
      <div class=${classMap({ 'acp-settings-agents__text': true, 'acp-settings-agents__text_off': !agent.enabled })}>
        <div class="acp-settings-agents__title">
          <span class="acp-settings-agents__name">${agent.name}</span>
          ${isDefault ? html`<span class="acp-settings-agents__default" title="New sessions start with it">Default</span>` : nothing}
        </div>
        <div class="acp-settings-agents__details">
          <span>ACP</span>
          ${agent.version
            ? html`<span aria-hidden="true">·</span>
                <span class="acp-settings-agents__version">${agent.version}</span>`
            : nothing}
          <span aria-hidden="true">·</span>
          <span class="acp-settings-agents__dot acp-settings-agents__dot_${status.kind}"></span>
          <span>${status.label}</span>
        </div>
      </div>
      <md-switch
        class="acp-settings-agents__switch"
        aria-label=${`${agent.name} on`}
        title=${agent.enabled ? 'Turn off: no new sessions, and its sessions stop' : 'Turn on'}
        .selected=${live(agent.enabled)}
        @change=${(/** @type {Event} */ e) =>
          this.#emit('acp-agent-enable', { agentId: agent.id, enabled: /** @type {HTMLElementTagNameMap['md-switch']} */ (e.currentTarget).selected })}
      ></md-switch>
      <md-icon-button
        class=${classMap({ 'acp-settings-agents__more': true, 'acp-settings-agents__more_shown': showMore })}
        title="Agent menu"
        aria-label=${`Agent menu: ${agent.name}`}
        @click=${(/** @type {Event} */ e) => this.#menu.openFrom(agent, /** @type {HTMLElement} */ (e.currentTarget))}
      >
        <md-icon class="acp-settings-agents__more-icon">${unsafeSVG(moreIcon)}</md-icon>
      </md-icon-button>
    </li>`;
  }

  /** @param {AgentSummary | null} agent The agent edited; `null`: a new one. */
  #renderForm(agent) {
    const { known, name, custom, command } = this.draft;
    return html`<div class="acp-settings-agents__form" @keydown=${this.#onFormKeydown}>
      <span class="acp-settings-agents__subtitle">${agent ? `Edit ${agent.name}` : 'New ACP agent'}</span>
      <md-select class="acp-settings-agents__input acp-settings-agents__select" variant="outlined" label="Agent" .value=${known} @change=${this.#onPick}>
        ${(this.agents?.known ?? []).map((k) => html`<md-option value=${k.id}>${k.name}</md-option>`)}
        <md-option value="">Other agent</md-option>
      </md-select>
      <md-text-field
        class="acp-settings-agents__input"
        variant="outlined"
        label="Name"
        spellcheck="false"
        .value=${name}
        @input=${(/** @type {Event} */ e) => this.#onInput('name', e)}
      ></md-text-field>
      <md-text-field
        class="acp-settings-agents__input acp-settings-agents__input_mono"
        variant="outlined"
        label="Command"
        spellcheck="false"
        autocapitalize="off"
        ?disabled=${!custom}
        .value=${command}
        @input=${(/** @type {Event} */ e) => this.#onInput('command', e)}
      >
        ${custom ? nothing : html`<md-icon slot="trailing-icon" class="acp-settings-agents__lock">${unsafeSVG(lockIcon)}</md-icon>`}
      </md-text-field>
      <span class="acp-settings-agents__hint"
        >${custom
          ? 'Program and arguments in one line, as in a terminal. Quote arguments with spaces.'
          : 'From the ACP agent registry. Check the box to change it.'}</span
      >
      <label class="acp-settings-agents__check">
        <md-checkbox class="acp-settings-agents__custom" ?disabled=${!known} .checked=${custom} @change=${this.#onCustom}></md-checkbox>
        Use custom command
      </label>
      ${agent
        ? nothing
        : html`<span class="acp-settings-agents__hint">Saved to the project's .brama/agents.json (yours, with no project open).</span>`}
      ${this.error ? html`<span class="acp-settings-agents__error" role="alert">${this.error}</span>` : nothing}
      <div class="acp-settings-agents__actions">
        ${agent
          ? html`<md-button class="acp-settings-agents__button acp-settings-agents__button_danger" variant="text" @click=${() => this.#remove(agent.id)}
              >Remove</md-button
            >`
          : nothing}
        <span class="acp-settings-agents__spacer"></span>
        <md-button class="acp-settings-agents__button" variant="text" @click=${this.#close}>Cancel</md-button>
        <md-button class="acp-settings-agents__button" variant="filled" ?disabled=${!this.#canSave} @click=${this.#save}
          >Save</md-button
        >
      </div>
    </div>`;
  }

  /**
   * The user's own agents, which no longer apply to a project, with the offer to copy them in.
   * @param {readonly AgentSummary[]} userAgents
   */
  #renderElsewhere(userAgents) {
    const names = userAgents.map((a) => a.name);
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return html`<div class="acp-settings-agents__elsewhere">
      <span class="acp-settings-agents__elsewhere-text"
        >${listed} ${names.length === 1 ? 'is' : 'are'} in your own agents.json, which applies only with no project open.</span
      >
      <md-button
        class="acp-settings-agents__button acp-settings-agents__elsewhere-button"
        variant="text"
        @click=${() => this.#emit('acp-agents-import', null)}
        >Add to this project</md-button
      >
    </div>`;
  }

  #renderMenu() {
    const agent = this.#menu.target;
    const isDefault = agent !== null && agent.id === this.agents?.defaultAgent;
    // The backend refuses an agent that's off.
    const canDefault = agent !== null && agent.enabled && !isDefault;
    return html`<md-menu
      class="acp-settings-agents__menu"
      placement="bottom-end"
      aria-label=${agent?.name ?? 'Agent'}
      @select=${this.#menu.onSelect}
      @closed=${this.#menu.onClosed}
    >
      <md-item-group>
        <md-menu-item class="acp-settings-agents__menu-item" value="edit">
          <md-icon slot="leading" class="acp-settings-agents__menu-icon">${unsafeSVG(editIcon)}</md-icon>
          Edit
        </md-menu-item>
        <md-menu-item class="acp-settings-agents__menu-item" value="default" ?disabled=${!canDefault}>
          <md-icon slot="leading" class="acp-settings-agents__menu-icon">${unsafeSVG(starIcon)}</md-icon>
          Set as default
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item class="acp-settings-agents__menu-item acp-settings-agents__menu-item_danger" value="remove">
          <md-icon slot="leading" class="acp-settings-agents__menu-icon">${unsafeSVG(deleteIcon)}</md-icon>
          Remove
        </md-menu-item>
      </md-item-group>
    </md-menu>`;
  }

  render() {
    const { agents = [], errors = [], defaultAgent = null, userAgents = [] } = this.agents ?? {};
    return html`
      ${errors.map((error) => html`<p class="acp-settings-agents__problem">${error}</p>`)}
      ${userAgents.length ? this.#renderElsewhere(userAgents) : nothing}
      ${agents.length
        ? html`<ul class="acp-settings-agents__list">
            ${agents.map((agent) =>
              agent.id === this.editing
                ? html`<li class="acp-settings-agents__edit">${this.#renderForm(agent)}</li>`
                : this.#renderRow(agent, agent.id === defaultAgent),
            )}
          </ul>`
        : html`<p class="acp-settings-agents__empty">No agents yet. Add an ACP agent to start a session.</p>`}
      ${this.adding
        ? this.#renderForm(null)
        : html`<md-button class="acp-settings-agents__add" variant="text" @click=${() => this.startAdding()}>
            <md-icon slot="icon" class="acp-settings-agents__icon">${unsafeSVG(addIcon)}</md-icon>
            Add agent
          </md-button>`}
      ${this.#renderMenu()}
    `;
  }
}

customElements.define('acp-settings-agents', AcpSettingsAgents);
