import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/chips';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/switch';
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import cloudOffIcon from '@material-design-icons/svg/outlined/cloud_off.svg?raw';
import dataObjectIcon from '@material-design-icons/svg/outlined/data_object.svg?raw';
import deleteIcon from '@material-design-icons/svg/outlined/delete.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import searchIcon from '@material-design-icons/svg/outlined/search.svg?raw';
import starIcon from '@material-design-icons/svg/outlined/star.svg?raw';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { glyphOf, ownSignIns } from '../../models/agents.js';
import '../acp-agent-form/acp-agent-form.js';
import styles from './acp-agents-view.css?inline';

/** @typedef {import('../../models/types.js').AgentsView} AgentsView */
/** @typedef {import('../../models/types.js').AgentRow} AgentRow */
/** @typedef {import('../../models/types.js').RegistryRow} RegistryRow */
/** @typedef {import('../../models/types.js').AgentsQuery} AgentsQuery */
/** @typedef {import('../../models/types.js').AgentsFilter} AgentsFilter */
/** @typedef {import('../../models/types.js').AgentsReveal} AgentsReveal */
/** @typedef {import('../../models/types.js').KnownAgent} KnownAgent */
/** @typedef {import('../../models/types.js').SignInRun} SignInRun */

/** @type {Record<AgentRow['status'], string>} */
const STATUS = { ready: 'Ready', notStarted: 'Not started yet', off: 'Off', signIn: 'Needs sign-in' };

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
 * @fires acp-agent-enable `{ agentId, enabled }`
 * @fires acp-agent-version-update `{ agentId }`
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
    reveal: { attribute: false },
    editing: { state: true },
    addingFromRegistry: { state: true },
    registryError: { state: true },
    revealed: { state: true },
  };

  static styles = styles;

  /** @type {ContextMenuController<AgentRow>} */
  #menu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-agents-view__menu'),
    onSelect: (value, agent) => this.#onMenuSelect(value, agent),
  });
  /** @type {ContextMenuController<AgentRow>} An agent's ways to sign in, when it has more than one. */
  #signInMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-agents-view__sign-in-menu'),
    onSelect: (methodId, agent) => this.#emit('acp-agent-sign-in', { agentId: agent.id, methodId }),
  });
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

  /**
   * @param {string} value
   * @param {AgentRow} agent
   */
  #onMenuSelect(value, agent) {
    if (value === 'edit') {
      this.editing = agent.id;
    } else if (value === 'default') this.#emit('acp-agent-default', { agentId: agent.id });
    else if (value === 'remove') this.#emit('acp-agent-remove', { agentId: agent.id });
  }

  /** @param {RegistryRow} entry */
  #addFromRegistry(entry) {
    this.addingFromRegistry = entry.id;
    this.registryError = null;
    this.#emit('acp-agent-add', { agent: { name: '', known: entry.id } });
  }

  /**
   * The name with what the search matched marked.
   * @param {string} name
   * @param {readonly [number, number][]} matches UTF-16 ranges.
   */
  #renderName(name, matches) {
    /** @type {unknown[]} */
    const parts = [];
    let at = 0;
    for (const [start, end] of matches) {
      parts.push(name.slice(at, start), html`<mark class="acp-agents-view__mark">${name.slice(start, end)}</mark>`);
      at = end;
    }
    parts.push(name.slice(at));
    return parts;
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

  /** @param {AgentRow} agent */
  #renderUpdate(agent) {
    if (!agent.update) return nothing;
    if (agent.updating || this.pending.updating.includes(agent.id)) {
      return html`<md-button class="acp-agents-view__button" variant="text" disabled>
        <md-progress-circular slot="icon" class="acp-agents-view__spinner"></md-progress-circular>
        Updating…
      </md-button>`;
    }
    return html`<md-button
        id=${tipId('update', agent.id)}
        class="acp-agents-view__button"
        variant="text"
        @click=${() => this.#emit('acp-agent-version-update', { agentId: agent.id })}
        >${agent.update.pin ? `Pin latest (${agent.update.to})` : 'Update'}</md-button
      >
      ${tooltip(tipId('update', agent.id), agent.update.pin ? 'Its version is unknown: pin the registry’s in agents.json' : `Pin ${agent.update.to} in agents.json`)}`;
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

  /** @param {AgentRow} agent */
  #renderSignIn(agent) {
    if (agent.status !== 'signIn' || !agent.signIn) return nothing;
    if (agent.signIn.pending || this.signIns[agent.id]?.state === 'waiting') {
      return html`<md-button class="acp-agents-view__button" variant="text" disabled>
        <md-progress-circular slot="icon" class="acp-agents-view__spinner"></md-progress-circular>
        Signing in…
      </md-button>`;
    }
    const methods = ownSignIns(agent.signIn.methods);
    if (!methods.length) {
      return html`<md-button
          id=${tipId('sign-in', agent.id)}
          class="acp-agents-view__button"
          variant="text"
          @click=${() => this.#emit('acp-agent-sign-in', { agentId: agent.id, methodId: null })}
          >Retry</md-button
        >
        ${tooltip(tipId('sign-in', agent.id), "Check whether you're signed in now")}`;
    }
    const [only] = methods;
    return html`<md-button
      class="acp-agents-view__button"
      variant="text"
      aria-haspopup=${methods.length > 1 ? 'menu' : nothing}
      @click=${(/** @type {Event} */ e) =>
        methods.length > 1
          ? this.#signInMenu.openFrom(agent, /** @type {HTMLElement} */ (e.currentTarget))
          : this.#emit('acp-agent-sign-in', { agentId: agent.id, methodId: only.id })}
      >Sign in</md-button
    >`;
  }

  /** @param {AgentRow} agent */
  #renderDetails(agent) {
    const parts = [agent.scope === 'project' ? 'Project' : 'Yours'];
    if (agent.version) parts.push(agent.update && !agent.update.pin ? `${agent.version} → ${agent.update.to}` : agent.version);
    parts.push(STATUS[agent.status]);
    return parts.join(' · ');
  }

  /** @param {AgentRow} agent */
  #renderAgent(agent) {
    if (agent.id === this.editing) {
      return html`<li class="acp-agents-view__edit" data-agent-id=${agent.id}>
        <acp-agent-form .known=${this.known} .agent=${agent} @acp-agent-form-close=${() => (this.editing = null)}></acp-agent-form>
      </li>`;
    }
    const menuOpen = this.#menu.target?.id === agent.id;
    const failed = agent.status === 'signIn' ? this.signIns[agent.id] : undefined;
    return html`<li
      class=${classMap({ 'acp-agents-view__row': true, 'acp-agents-view__row_revealed': this.revealed === agent.id })}
      data-agent-id=${agent.id}
      @contextmenu=${(/** @type {MouseEvent} */ e) => this.#menu.onContextMenu(agent, e)}
      @keydown=${(/** @type {KeyboardEvent} */ e) => this.#menu.onKeydown(agent, e)}
    >
      <span class=${classMap({ 'acp-agents-view__glyph': true, 'acp-agents-view__glyph_off': !agent.enabled })} aria-hidden="true"
        >${glyphOf(agent.name)}</span
      >
      <div class=${classMap({ 'acp-agents-view__text': true, 'acp-agents-view__text_off': !agent.enabled })}>
        <div class="acp-agents-view__title">
          <span class="acp-agents-view__name">${this.#renderName(agent.name, agent.nameMatches)}</span>
          ${agent.isDefault ? html`<span id=${tipId('default', agent.id)} class="acp-agents-view__default">Default</span>` : nothing}
        </div>
        <div class="acp-agents-view__details">${this.#renderDetails(agent)}</div>
        ${failed?.state === 'failed' ? this.#renderError(tipId('sign-in-error', agent.id), `Signing in failed: ${failed.message ?? 'unknown error'}`) : nothing}
      </div>
      ${this.#renderSignIn(agent)} ${this.#renderUpdate(agent)}
      <md-switch
        id=${tipId('switch', agent.id)}
        class="acp-agents-view__switch"
        aria-label=${`${agent.name} on`}
        .selected=${live(agent.enabled)}
        @change=${(/** @type {Event} */ e) =>
          this.#emit('acp-agent-enable', { agentId: agent.id, enabled: /** @type {HTMLElementTagNameMap['md-switch']} */ (e.currentTarget).selected })}
      ></md-switch>
      <md-icon-button
        id=${tipId('more', agent.id)}
        class="acp-agents-view__more"
        aria-label=${`Agent menu: ${agent.name}`}
        aria-expanded=${menuOpen ? 'true' : 'false'}
        @click=${(/** @type {Event} */ e) => this.#menu.openFrom(agent, /** @type {HTMLElement} */ (e.currentTarget))}
      >
        <md-icon class="acp-agents-view__icon">${unsafeSVG(moreIcon)}</md-icon>
      </md-icon-button>
      ${agent.isDefault ? tooltip(tipId('default', agent.id), 'New sessions start with it') : nothing}
      ${tooltip(tipId('switch', agent.id), agent.enabled ? 'Turn off: no new sessions, and its sessions stop' : 'Turn on')}
      ${tooltip(tipId('more', agent.id), 'Agent menu')}
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
            <span class="acp-agents-view__glyph" aria-hidden="true">${glyphOf(agent.name)}</span>
            <div class="acp-agents-view__text">
              <div class="acp-agents-view__title">
                <span class="acp-agents-view__name">${this.#renderName(agent.name, agent.nameMatches)}</span>
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
      <span class="acp-agents-view__glyph" aria-hidden="true">${glyphOf(entry.name)}</span>
      <div id=${tipId('registry', entry.id)} class="acp-agents-view__text">
        <div class="acp-agents-view__title">
          <span class="acp-agents-view__name">${this.#renderName(entry.name, entry.nameMatches)}</span>
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
      ? `Last checked ${new Date(checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
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

  #renderMenu() {
    const agent = this.#menu.target;
    const canDefault = agent !== null && agent.enabled && !agent.isDefault;
    return html`<md-menu
      class="acp-agents-view__menu"
      placement="bottom-end"
      aria-label=${agent?.name ?? 'Agent'}
      @select=${this.#menu.onSelect}
      @closed=${this.#menu.onClosed}
    >
      <md-item-group>
        <md-menu-item class="acp-agents-view__menu-item" value="edit">
          <md-icon slot="leading" class="acp-agents-view__icon">${unsafeSVG(editIcon)}</md-icon>
          Edit
        </md-menu-item>
        <md-menu-item class="acp-agents-view__menu-item" value="default" ?disabled=${!canDefault}>
          <md-icon slot="leading" class="acp-agents-view__icon">${unsafeSVG(starIcon)}</md-icon>
          Set as default
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item class="acp-agents-view__menu-item acp-agents-view__menu-item_danger" value="remove">
          <md-icon slot="leading" class="acp-agents-view__icon">${unsafeSVG(deleteIcon)}</md-icon>
          Remove
        </md-menu-item>
      </md-item-group>
    </md-menu>`;
  }

  #renderSignInMenu() {
    const agent = this.#signInMenu.target;
    return html`<md-menu
      class="acp-agents-view__sign-in-menu"
      placement="bottom-end"
      aria-label=${agent ? `Sign in to ${agent.name}` : 'Sign in'}
      @select=${this.#signInMenu.onSelect}
      @closed=${this.#signInMenu.onClosed}
    >
      ${ownSignIns(agent?.signIn?.methods ?? []).map(
        (method) => html`<md-menu-item class="acp-agents-view__menu-item" value=${method.id}>
          ${method.name}
          ${method.description ? html`<span slot="supporting-text">${method.description}</span>` : nothing}
        </md-menu-item>`,
      )}
    </md-menu>`;
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
      ${this.#renderMenu()} ${this.#renderSignInMenu()}
    </div>`;
  }
}
customElements.define('acp-agents-view', AcpAgentsView);
