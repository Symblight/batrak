import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/chips';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import cloudOffIcon from '@material-design-icons/svg/outlined/cloud_off.svg?raw';
import dataObjectIcon from '@material-design-icons/svg/outlined/data_object.svg?raw';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import '../agent-icon/agent-icon.js';
import '../datetime/datetime.js';
import '../agent-card/agent-card.js';
import '../agent-form/agent-form.js';
import '../marked-text/marked-text.js';
import styles from './agents-view.css?inline';

/** @typedef {import('../../hooks/agents/types.js').AgentsView} AgentsView */
/** @typedef {import('../../hooks/agents/types.js').AgentRow} AgentRow */
/** @typedef {import('../../hooks/agents/types.js').RegistryRow} RegistryRow */
/** @typedef {import('../../hooks/agents/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../hooks/agents/types.js').AgentsFilter} AgentsFilter */
/** @typedef {import('../../hooks/agents/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../hooks/agents/types.js').KnownAgent} KnownAgent */
/** @typedef {import('../../hooks/agents/types.js').SignInRun} SignInRun */

/**
 * The anchor id of a tooltip: unique in the shadow root.
 * @param {string} part What it's on (`switch`, `update`…).
 * @param {string} [id] The agent or registry entry it's of.
 */
const tipId = (part, id = '') => `acp-agents-view-${part}${id ? `-${id}` : ''}`;

/**
 * @param {string} anchor An element's id.
 * @param {string} text
 */
const tooltip = (anchor, text) => html`<md-tooltip for=${anchor} show-delay="800">${text}</md-tooltip>`;

/** @type {{ filter: AgentsFilter, label: string, count?: 'updates' | 'off' }[]} */
const CHIPS = [
  { filter: 'all', label: 'All' },
  { filter: 'updates', label: 'Updates', count: 'updates' },
  { filter: 'off', label: 'Off', count: 'off' },
];

/**
 * @tag acp-agents-view
 * @summary The Agents tab: the installed agents (switch, Update, menu), the user's own agents and the ACP registry's that Brama supports, searched and filtered by the backend.
 * @fires acp-agents-query `{ query, filter }`
 * @fires acp-agent-enable `{ agentId, enabled }` From a card.
 * @fires acp-agent-session-view `{ agentId, view }` From a card: whether its sessions open in the terminal.
 * @fires acp-agent-version-update `{ agentId }` From a card.
 * @fires acp-agents-update-all `null`
 * @fires acp-agents-registry-check `null`
 * @fires acp-agent-add `{ agent }` A `NewAgent` (a registry agent's `known` id from its row); the container answers with `saveFinished()`.
 * @fires acp-agent-update `{ agentId, agent }` From the edit form.
 * @fires acp-agent-default `{ agentId }`
 * @fires acp-agent-remove `{ agentId }`
 * @fires acp-agent-sign-in `{ agentId, methodId }` `methodId: null` is Retry (only checks).
 * @fires acp-agents-import `{ agentIds }` The user's own agents to copy into the project.
 * @fires acp-agents-file-open `null`
 * @fires acp-agents-revealed `{ reveal }`
 */
export class AcpAgentsView extends LitElement {
  static properties = {
    view: { attribute: false },
    query: { attribute: false },
    known: { attribute: false },
    pending: { attribute: false },
    signIns: { attribute: false },
    terminalAgents: { attribute: false },
    reveal: { attribute: false },
    editing: { state: true },
    addingFromRegistry: { state: true },
    registryError: { state: true },
    revealed: { state: true },
  };

  static styles = styles;

  /** @type {AgentsReveal | null} A reveal just rendered, to scroll to and confirm. */
  #shown = null;

  constructor() {
    super();
    /** @type {AgentsView | null} The backend's answer for `query`. */
    this.view = null;
    /** @type {AgentsQuery} */
    this.query = { query: '', filter: 'all' };
    /** @type {readonly KnownAgent[]} The registry agents the add form offers. */
    this.known = [];
    /** @type {{ updating: readonly string[], checking: boolean }} Calls this window waits for. */
    this.pending = { updating: [], checking: false };
    /** @type {Readonly<Record<string, SignInRun>>} Sign-ins of the shown agents running or failed, by agent id. */
    this.signIns = {};
    /** @type {readonly string[]} The agents whose sessions open in the terminal. */
    this.terminalAgents = [];
    /** @type {AgentsReveal | null} What to show; `acp-agents-revealed` once shown. */
    this.reveal = null;
    /** @type {string | null} The agent whose edit form is open, in place of its row. */
    this.editing = null;
    /** @type {string | null} The registry agent being added. */
    this.addingFromRegistry = null;
    /** @type {{ id: string, message: string } | null} Why adding a registry agent failed. */
    this.registryError = null;
    /** @type {string | null} The agent last shown on request, marked. */
    this.revealed = null;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.#onDocumentKeydown);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this.#onDocumentKeydown);
    super.disconnectedCallback();
  }

  /** @param {import('lit').PropertyValues<this>} changed */
  willUpdate(changed) {
    // agents.json no longer has the agent being edited.
    if (changed.has('view') && this.editing && !this.view?.installed.some((a) => a.id === this.editing)) this.editing = null;
    const reveal = this.reveal;
    if (!reveal || !(changed.has('reveal') || changed.has('view'))) return;
    if (reveal.add) {
      this.#shown = reveal;
    } else if (reveal.agentId && this.view?.installed.some((a) => a.id === reveal.agentId)) {
      // Not listed yet, the view's next answer may list it.
      this.revealed = reveal.agentId;
      this.#shown = reveal;
    }
  }

  updated() {
    const shown = this.#shown;
    if (!shown) return;
    this.#shown = null;
    if (shown.agentId) this.renderRoot.querySelector(`[data-agent-id="${CSS.escape(shown.agentId)}"]`)?.scrollIntoView({ block: 'center' });
    if (shown.add) this.renderRoot.querySelector('.acp-agents-view__registry')?.scrollIntoView({ block: 'start' });
    this.#emit('acp-agents-revealed', { reveal: shown });
  }

  /**
   * The container's answer to an `acp-agent-add` from a registry row: `null` once added.
   * @param {string | null} error
   */
  saveFinished(error) {
    const id = this.addingFromRegistry;
    this.addingFromRegistry = null;
    this.registryError = error !== null && id !== null ? { id, message: error } : null;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Partial<AgentsQuery>} change */
  #ask(change) {
    this.#emit('acp-agents-query', { ...this.query, ...change });
  }

  get #input() {
    return /** @type {HTMLInputElement | null} */ (this.renderRoot.querySelector('.acp-agents-view__search-input'));
  }

  /** ⌘F / Ctrl+F while the tab shows: the search. */
  #onDocumentKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
    if (!this.isConnected || !this.checkVisibility()) return;
    e.preventDefault();
    this.#input?.focus();
    this.#input?.select();
  };

  #onSearchKeydown = (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    this.#ask({ query: '' });
  };

  /** @param {Event} e */
  #onEdit(e) {
    e.stopPropagation();
    this.editing = /** @type {CustomEvent<{ agentId: string }>} */ (e).detail.agentId;
  }

  /** @param {RegistryRow} entry */
  #addFromRegistry(entry) {
    this.addingFromRegistry = entry.id;
    this.registryError = null;
    this.#emit('acp-agent-add', { agent: { name: '', known: entry.id } });
  }

  #renderHeader() {
    return html`<header class="acp-agents-view__header">
      <h2 class="acp-agents-view__title-text">Agents</h2>
      <md-button class="acp-agents-view__button" variant="text" @click=${() => this.#emit('acp-agents-file-open', null)}>
        <md-icon slot="icon" class="acp-agents-view__icon">${unsafeSVG(dataObjectIcon)}</md-icon>
        Edit agents.json
      </md-button>
    </header>`;
  }

  #renderSearch() {
    const { query } = this.query;
    return html`<div class="acp-agents-view__search">
      <md-icon class="acp-agents-view__search-icon">${unsafeSVG(searchIcon)}</md-icon>
      <input
        class="acp-agents-view__search-input"
        type="search"
        placeholder="Search agents"
        aria-label="Search agents"
        spellcheck="false"
        autocomplete="off"
        .value=${live(query)}
        @input=${(/** @type {Event} */ e) => this.#ask({ query: /** @type {HTMLInputElement} */ (e.target).value })}
        @keydown=${this.#onSearchKeydown}
      />
      ${query
        ? html`<md-icon-button id=${tipId('clear')} class="acp-agents-view__clear" aria-label="Clear search" @click=${() => this.#ask({ query: '' })}>
              <md-icon class="acp-agents-view__icon">${unsafeSVG(closeIcon)}</md-icon>
            </md-icon-button>
            ${tooltip(tipId('clear'), 'Clear')}`
        : nothing}
    </div>`;
  }

  /** @param {AgentsView} view */
  #renderChips(view) {
    return html`<div class="acp-agents-view__chips" role="group" aria-label="Filter">
      ${CHIPS.map(
        ({ filter, label, count }) => html`<md-filter-chip
          class="acp-agents-view__chip"
          .selected=${live(this.query.filter === filter)}
          @click=${() => this.#ask({ filter })}
          >${label}${count ? html` <span class="acp-agents-view__count">${view.counts[count]}</span>` : nothing}</md-filter-chip
        >`,
      )}
    </div>`;
  }

  /**
   * A row's error: one line, the whole of it in a tooltip.
   * @param {string} id
   * @param {string} message
   */
  #renderError(id, message) {
    return html`<div id=${id} class="acp-agents-view__error" role="alert">${message}</div>
      ${tooltip(id, message)}`;
  }

  /** @param {{ id: string, name: string }} agent */
  #renderGlyph(agent) {
    return html`<span class="acp-agents-view__glyph" aria-hidden="true"
      ><acp-agent-icon class="acp-agents-view__glyph-icon" .agent=${agent}></acp-agent-icon></span
    >`;
  }

  /** @param {AgentRow} agent */
  #renderAgent(agent) {
    if (agent.id === this.editing) {
      return html`<li class="acp-agents-view__edit" data-agent-id=${agent.id}>
        <acp-agent-form .known=${this.known} .agent=${agent} @acp-agent-form-close=${() => (this.editing = null)}></acp-agent-form>
      </li>`;
    }
    return html`<li class="acp-agents-view__item" data-agent-id=${agent.id}>
      <acp-agent-card
        .agent=${agent}
        .terminalView=${this.terminalAgents.includes(agent.id)}
        .updating=${this.pending.updating.includes(agent.id)}
        .signIn=${this.signIns[agent.id]}
        .revealed=${this.revealed === agent.id}
        @acp-agent-edit=${this.#onEdit}
      ></acp-agent-card>
    </li>`;
  }

  /** @param {AgentsView} view */
  #renderInstalled(view) {
    const updates = view.installed.filter((a) => a.update).length;
    return html`<section class="acp-agents-view__group" aria-label="Installed agents">
      <div class="acp-agents-view__group-header">
        <h3 class="acp-agents-view__group-title">Installed · ${view.installed.length}</h3>
        ${updates >= 2 && !this.query.query
          ? html`<md-button class="acp-agents-view__button acp-agents-view__update-all" variant="text" @click=${() => this.#emit('acp-agents-update-all', null)}
              >Update all</md-button
            >`
          : nothing}
      </div>
      ${view.installed.length
        ? html`<ul class="acp-agents-view__list">${view.installed.map((agent) => this.#renderAgent(agent))}</ul>`
        : html`<p class="acp-agents-view__note">${this.query.filter === 'all' ? 'No agents yet. Add one from the registry below.' : 'None.'}</p>`}
    </section>`;
  }

  /** @param {AgentsView} view */
  #renderUserAgents(view) {
    if (!view.userAgents.length) return nothing;
    return html`<section class="acp-agents-view__group" aria-label="Your agents">
      <div class="acp-agents-view__group-header">
        <h3 class="acp-agents-view__group-title">Your agents</h3>
        <md-button
          class="acp-agents-view__button"
          variant="text"
          @click=${() => this.#emit('acp-agents-import', { agentIds: view.userAgents.map((a) => a.id) })}
          >Add all</md-button
        >
      </div>
      <p class="acp-agents-view__note">In your own agents.json, which applies only with no project open.</p>
      <ul class="acp-agents-view__list">
        ${view.userAgents.map(
          (agent) => html`<li class="acp-agents-view__row" data-agent-id=${agent.id}>
            ${this.#renderGlyph(agent)}
            <div class="acp-agents-view__text">
              <div class="acp-agents-view__title">
                <span class="acp-agents-view__name"><acp-marked-text .text=${agent.name} .ranges=${agent.nameMatches}></acp-marked-text></span>
              </div>
              <div class="acp-agents-view__details">${[agent.command, ...agent.args].join(' ')}</div>
            </div>
            <md-button class="acp-agents-view__button" variant="text" @click=${() => this.#emit('acp-agents-import', { agentIds: [agent.id] })}
              >Add to project</md-button
            >
          </li>`,
        )}
      </ul>
    </section>`;
  }

  /** @param {RegistryRow} entry */
  #renderRegistryAgent(entry) {
    const adding = this.addingFromRegistry === entry.id;
    const error = this.registryError?.id === entry.id ? this.registryError.message : null;
    const details = [entry.vendor, entry.commandLine].filter(Boolean).join(' · ');
    return html`<li class="acp-agents-view__row" data-agent-id=${entry.id}>
      ${this.#renderGlyph(entry)}
      <div id=${tipId('registry', entry.id)} class="acp-agents-view__text">
        <div class="acp-agents-view__title">
          <span class="acp-agents-view__name"><acp-marked-text .text=${entry.name} .ranges=${entry.nameMatches}></acp-marked-text></span>
        </div>
        <div class="acp-agents-view__details">${details}</div>
        ${error ? this.#renderError(tipId('add-error', entry.id), error) : nothing}
      </div>
      <md-button
        id=${tipId('add', entry.id)}
        class="acp-agents-view__button"
        variant="text"
        ?disabled=${this.addingFromRegistry !== null}
        @click=${() => this.#addFromRegistry(entry)}
        >${adding ? 'Adding…' : 'Add'}</md-button
      >
      ${entry.description ? tooltip(tipId('registry', entry.id), entry.description) : nothing}
      ${tooltip(tipId('add', entry.id), `Add ${entry.name}, pinned to the registry's version`)}
    </li>`;
  }

  /** @param {AgentsView} view */
  #renderRegistry(view) {
    if (!view.registry.length) return nothing;
    return html`<section class="acp-agents-view__group acp-agents-view__registry" aria-label="From the ACP registry">
      <div class="acp-agents-view__group-header">
        <h3 class="acp-agents-view__group-title">From the ACP registry</h3>
      </div>
      <ul class="acp-agents-view__list">${view.registry.map((entry) => this.#renderRegistryAgent(entry))}</ul>
    </section>`;
  }

  /** @param {AgentsView} view */
  #renderEmpty(view) {
    const query = this.query.query.trim();
    if (view.installed.length || view.userAgents.length || view.registry.length) return nothing;
    const { checkedAt, offline } = view.registryState;
    // Agents are known only from the registry, so before its first answer nothing is listed.
    const note = !checkedAt
      ? offline
        ? 'Couldn’t reach the ACP registry, which lists the agents. Brama tries again every minute.'
        : 'Getting the agents from the ACP registry…'
      : query
        ? `No agents match “${query}”.`
        : null;
    if (!note) return nothing;
    return html`<div class="acp-agents-view__empty">
      <p class="acp-agents-view__note">${note}</p>
    </div>`;
  }

  /** @param {AgentsView} view */
  #renderFooter(view) {
    const { checkedAt, offline } = view.registryState;
    const checking = view.registryState.checking || this.pending.checking;
    const when = checkedAt
      ? html`Last checked <acp-datetime .value=${checkedAt} format="medium"></acp-datetime>`
      : 'Not checked yet';
    return html`<footer class="acp-agents-view__footer">
      <p class="acp-agents-view__footer-text">
        Versions are checked against the ACP registry daily. Running sessions keep their version until restarted.
      </p>
      <div class="acp-agents-view__footer-state">
        ${offline
          ? html`<md-icon id=${tipId('offline')} class="acp-agents-view__icon">${unsafeSVG(cloudOffIcon)}</md-icon>
              ${tooltip(tipId('offline'), 'The last check failed')}`
          : nothing}
        <span>${when}${offline ? ' · offline' : ''}</span>
        <md-button class="acp-agents-view__button" variant="text" ?disabled=${checking} @click=${() => this.#emit('acp-agents-registry-check', null)}
          >${checking ? 'Checking…' : 'Check now'}</md-button
        >
      </div>
    </footer>`;
  }

  render() {
    const view = this.view;
    return html`<div class="acp-agents-view__page">
      ${this.#renderHeader()}
      ${view?.errors.map((error) => html`<p class="acp-agents-view__problem">${error}</p>`)} ${this.#renderSearch()}
      ${view ? this.#renderChips(view) : nothing}
      ${view
        ? html`${this.#renderEmpty(view)} ${this.#renderInstalled(view)} ${this.#renderUserAgents(view)} ${this.#renderRegistry(view)}
          ${this.#renderFooter(view)}`
        : nothing}
    </div>`;
  }
}
customElements.define('acp-agents-view', AcpAgentsView);
