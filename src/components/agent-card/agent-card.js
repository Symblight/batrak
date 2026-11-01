import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/radio-button';
import '@symblight/wc-material/switch';
import '@symblight/wc-material/tooltip';
import deleteIcon from '@material-design-icons/svg/outlined/delete.svg?raw';
import editIcon from '@material-design-icons/svg/outlined/edit.svg?raw';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import starIcon from '@material-design-icons/svg/outlined/star.svg?raw';
import { ContextMenuController } from '../../controllers/context-menu/ContextMenuController.js';
import { agents } from '../../hooks/agents/agents.js';
import '../agent-icon/agent-icon.js';
import '../marked-text/marked-text.js';
import styles from './agent-card.css?inline';

/** @typedef {import('../../models/types/types.js').AgentRow} AgentRow */
/** @typedef {import('../../models/types/types.js').SignInRun} SignInRun */

/** @type {Record<AgentRow['status'], string>} */
const STATUS = { ready: 'Ready', notStarted: 'Not started yet', off: 'Off', signIn: 'Needs sign-in' };

/**
 * The anchor id of a tooltip: unique in the shadow root.
 * @param {string} part What it's on (`switch`, `update`…).
 */
const tipId = (part) => `acp-agent-card-${part}`;

/**
 * @param {string} anchor An element's id.
 * @param {string} text
 */
const tooltip = (anchor, text) => html`<md-tooltip for=${anchor} show-delay="800">${text}</md-tooltip>`;

/**
 * Its version, and the registry's newer one when an update is waiting.
 * @param {AgentRow} agent
 */
const versionOf = (agent) => (agent.update && !agent.update.pin ? `${agent.version} → ${agent.update.to}` : (agent.version ?? ''));

/**
 * @tag acp-agent-card
 * @summary An installed agent of the Agents tab: name, switch, where its sessions open (Chat or Terminal), its version, Update, Sign in and menu.
 * @fires acp-agent-enable `{ agentId, enabled }`
 * @fires acp-agent-session-view `{ agentId, view }` Its Chat / Terminal choice: whether its sessions open in the terminal (`view: 'terminal'`) or as Chat.
 * @fires acp-agent-version-update `{ agentId }`
 * @fires acp-agent-sign-in `{ agentId, methodId }` `methodId: null` is Retry (only checks).
 * @fires acp-agent-edit `{ agentId }` From the menu.
 * @fires acp-agent-default `{ agentId }`
 * @fires acp-agent-remove `{ agentId }`
 */
export class AcpAgentCard extends LitElement {
  static properties = {
    agent: { attribute: false },
    terminalView: { type: Boolean, attribute: 'terminal-view' },
    updating: { type: Boolean },
    signIn: { attribute: false },
    revealed: { type: Boolean, reflect: true },
  };

  static styles = styles;

  /** @type {ContextMenuController<AgentRow>} */
  #menu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-agent-card__menu'),
    onSelect: (value, agent) => this.#onMenuSelect(value, agent),
  });
  /** @type {ContextMenuController<AgentRow>} Its ways to sign in, when it has more than one. */
  #signInMenu = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('.acp-agent-card__sign-in-menu'),
    onSelect: (methodId, agent) => this.#emit('acp-agent-sign-in', { agentId: agent.id, methodId }),
  });

  constructor() {
    super();
    /** @type {AgentRow | null} */
    this.agent = null;
    /** @type {boolean} Its sessions open in the terminal (the Agents tab's choice). */
    this.terminalView = false;
    /** @type {boolean} An update of it runs in this window. */
    this.updating = false;
    /** @type {SignInRun | undefined} This window's sign-in of it, running or failed. */
    this.signIn = undefined;
    /** @type {boolean} Shown on request: marked. */
    this.revealed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('contextmenu', this.#onContextMenu);
    this.addEventListener('keydown', this.#onKeydown);
  }

  disconnectedCallback() {
    this.removeEventListener('contextmenu', this.#onContextMenu);
    this.removeEventListener('keydown', this.#onKeydown);
    super.disconnectedCallback();
  }

  /** The event comes from one of the card's own menus, which render inside it. @param {Event} e */
  #fromMenu(e) {
    return e.composedPath().some((node) => node instanceof HTMLElement && node.localName === 'md-menu');
  }

  /** @param {MouseEvent} e */
  #onContextMenu = (e) => {
    if (this.agent && !this.#fromMenu(e)) this.#menu.onContextMenu(this.agent, e);
  };

  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (this.agent && !this.#fromMenu(e)) this.#menu.onKeydown(this.agent, e);
  };

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * @param {string} value
   * @param {AgentRow} agent
   */
  #onMenuSelect(value, agent) {
    if (value === 'edit') this.#emit('acp-agent-edit', { agentId: agent.id });
    else if (value === 'default') this.#emit('acp-agent-default', { agentId: agent.id });
    else if (value === 'remove') this.#emit('acp-agent-remove', { agentId: agent.id });
  }

  /** @param {AgentRow} agent */
  #renderUpdate(agent) {
    if (!agent.update) return nothing;
    if (agent.updating || this.updating) {
      return html`<md-button class="acp-agent-card__button" variant="text" disabled>
        <md-progress-circular slot="icon" class="acp-agent-card__spinner"></md-progress-circular>
        Updating…
      </md-button>`;
    }
    return html`<md-button
        id=${tipId('update')}
        class="acp-agent-card__button"
        variant="text"
        @click=${() => this.#emit('acp-agent-version-update', { agentId: agent.id })}
        >${agent.update.pin ? `Pin latest (${agent.update.to})` : 'Update'}</md-button
      >
      ${tooltip(tipId('update'), agent.update.pin ? 'Its version is unknown: pin the registry’s in agents.json' : `Pin ${agent.update.to} in agents.json`)}`;
  }

  /** @param {AgentRow} agent */
  #renderSignIn(agent) {
    if (agent.status !== 'signIn' || !agent.signIn) return nothing;
    if (agent.signIn.pending || this.signIn?.state === 'waiting') {
      return html`<md-button class="acp-agent-card__button" variant="text" disabled>
        <md-progress-circular slot="icon" class="acp-agent-card__spinner"></md-progress-circular>
        Signing in…
      </md-button>`;
    }
    const methods = agents.ownSignIns(agent.signIn.methods);
    if (!methods.length) {
      return html`<md-button
          id=${tipId('sign-in')}
          class="acp-agent-card__button"
          variant="text"
          @click=${() => this.#emit('acp-agent-sign-in', { agentId: agent.id, methodId: null })}
          >Retry</md-button
        >
        ${tooltip(tipId('sign-in'), "Check whether you're signed in now")}`;
    }
    const [only] = methods;
    return html`<md-button
      class="acp-agent-card__button"
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
  #renderSignInError(agent) {
    const failed = agent.status === 'signIn' ? this.signIn : undefined;
    if (failed?.state !== 'failed') return nothing;
    const message = `Signing in failed: ${failed.message ?? 'unknown error'}`;
    return html`<div id=${tipId('sign-in-error')} class="acp-agent-card__error" role="alert">${message}</div>
      ${tooltip(tipId('sign-in-error'), message)}`;
  }

  /** @param {AgentRow} agent */
  #renderDetails(agent) {
    const parts = [agent.scope === 'project' ? 'Project' : 'Yours'];
    if (agent.version) parts.push(versionOf(agent));
    parts.push(STATUS[agent.status]);
    return parts.join(' · ');
  }

  /**
   * @param {AgentRow} agent
   * @param {boolean} [off]
   */
  #renderGlyph(agent, off = false) {
    return html`<span class="acp-agent-card__glyph ${off ? 'acp-agent-card__glyph_off' : ''}" aria-hidden="true"
      ><acp-agent-icon class="acp-agent-card__glyph-icon" .agent=${agent}></acp-agent-icon></span
    >`;
  }

  /** @param {AgentRow} agent */
  #renderTitle(agent) {
    return html`<div class="acp-agent-card__title">
        <span class="acp-agent-card__name"><acp-marked-text .text=${agent.name} .ranges=${agent.nameMatches}></acp-marked-text></span>
        ${agent.isDefault ? html`<span id=${tipId('default')} class="acp-agent-card__default">Default</span>` : nothing}
      </div>
      ${agent.isDefault ? tooltip(tipId('default'), 'New sessions start with it') : nothing}`;
  }

  /** @param {AgentRow} agent */
  #renderSwitch(agent) {
    return html`<md-switch
        id=${tipId('switch')}
        class="acp-agent-card__switch"
        aria-label=${`${agent.name} on`}
        .selected=${live(agent.enabled)}
        @change=${(/** @type {Event} */ e) =>
          this.#emit('acp-agent-enable', { agentId: agent.id, enabled: /** @type {HTMLElementTagNameMap['md-switch']} */ (e.currentTarget).selected })}
      ></md-switch>
      ${tooltip(tipId('switch'), agent.enabled ? 'Turn off: no new sessions, and its sessions stop' : 'Turn on')}`;
  }

  /** @param {AgentRow} agent */
  #renderMore(agent) {
    return html`<md-icon-button
        id=${tipId('more')}
        class="acp-agent-card__more"
        aria-label=${`Agent menu: ${agent.name}`}
        aria-expanded=${this.#menu.target?.id === agent.id ? 'true' : 'false'}
        @click=${(/** @type {Event} */ e) => this.#menu.openFrom(agent, /** @type {HTMLElement} */ (e.currentTarget))}
      >
        <md-icon class="acp-agent-card__icon">${unsafeSVG(moreIcon)}</md-icon>
      </md-icon-button>
      ${tooltip(tipId('more'), 'Agent menu')}`;
  }

  /** An agent that's off: no choice to make, its name, switch and menu only. @param {AgentRow} agent */
  #renderOff(agent) {
    return html`<div class="acp-agent-card__header">
      ${this.#renderGlyph(agent, true)}
      <div class="acp-agent-card__text acp-agent-card__text_off">
        ${this.#renderTitle(agent)}
        <div class="acp-agent-card__details">${this.#renderDetails(agent)}</div>
      </div>
      ${this.#renderUpdate(agent)} ${this.#renderSwitch(agent)} ${this.#renderMore(agent)}
    </div>`;
  }

  /**
   * An agent that's on: its name and switch, then where its sessions open, Chat (the ACP agent:
   * its version, update and menu) or Terminal (its own CLI; disabled when it has none).
   * @param {AgentRow} agent
   */
  #renderOn(agent) {
    const terminal = agent.terminal !== null && this.terminalView;
    /** @param {'chat' | 'terminal'} view */
    const pick = (view) => {
      if (view === 'terminal' && !agent.terminal) return;
      if ((view === 'terminal') !== terminal) this.#emit('acp-agent-session-view', { agentId: agent.id, view });
    };
    /**
     * @param {'chat' | 'terminal'} view
     * @param {string} label
     */
    const radio = (view, label) => html`<md-radio
      class="acp-agent-card__mode-radio"
      name=${`acp-agent-card-mode-${agent.id}`}
      value=${view}
      aria-label=${`${agent.name}: open sessions in ${label}`}
      ?disabled=${view === 'terminal' && !agent.terminal}
      .checked=${live(terminal === (view === 'terminal'))}
      @change=${(/** @type {Event} */ e) => {
        if (/** @type {HTMLElementTagNameMap['md-radio']} */ (e.currentTarget).checked) pick(view);
      }}
    ></md-radio>`;
    return html`<div class="acp-agent-card__header">
        ${this.#renderGlyph(agent)}
        <div class="acp-agent-card__text">${this.#renderTitle(agent)}</div>
        ${this.#renderSwitch(agent)}
      </div>
      <fieldset class="acp-agent-card__modes">
        <legend class="acp-agent-card__modes-legend">Open sessions in</legend>
        <div class="acp-agent-card__mode">
          ${radio('chat', 'Chat')}
          <div class="acp-agent-card__text acp-agent-card__mode-text" @click=${() => pick('chat')}>
            <div class="acp-agent-card__mode-name">
              Chat ${agent.version ? html`<span class="acp-agent-card__mode-version">${versionOf(agent)}</span>` : nothing}
            </div>
            <div class="acp-agent-card__details">${agent.description ?? this.#renderDetails(agent)}</div>
            ${this.#renderSignInError(agent)}
          </div>
          ${this.#renderSignIn(agent)} ${this.#renderUpdate(agent)} ${this.#renderMore(agent)}
        </div>
        <div class="acp-agent-card__mode">
          ${radio('terminal', 'Terminal')}
          <div
            class="acp-agent-card__text acp-agent-card__mode-text ${agent.terminal ? '' : 'acp-agent-card__text_off'}"
            @click=${() => pick('terminal')}
          >
            <div class="acp-agent-card__mode-name">Terminal</div>
            <div class="acp-agent-card__details">${agent.terminal ? 'CLI available' : 'No CLI for this agent'}</div>
          </div>
        </div>
      </fieldset>`;
  }

  #renderMenu() {
    const agent = this.#menu.target;
    const canDefault = agent !== null && agent.enabled && !agent.isDefault;
    return html`<md-menu
      class="acp-agent-card__menu"
      placement="bottom-end"
      aria-label=${agent?.name ?? 'Agent'}
      @select=${this.#menu.onSelect}
      @closed=${this.#menu.onClosed}
    >
      <md-item-group>
        <md-menu-item class="acp-agent-card__menu-item" value="edit">
          <md-icon slot="leading" class="acp-agent-card__icon">${unsafeSVG(editIcon)}</md-icon>
          Edit
        </md-menu-item>
        <md-menu-item class="acp-agent-card__menu-item" value="default" ?disabled=${!canDefault}>
          <md-icon slot="leading" class="acp-agent-card__icon">${unsafeSVG(starIcon)}</md-icon>
          Set as default
        </md-menu-item>
      </md-item-group>
      <md-item-group>
        <md-menu-item class="acp-agent-card__menu-item acp-agent-card__menu-item_danger" value="remove">
          <md-icon slot="leading" class="acp-agent-card__icon">${unsafeSVG(deleteIcon)}</md-icon>
          Remove
        </md-menu-item>
      </md-item-group>
    </md-menu>`;
  }

  #renderSignInMenu() {
    const agent = this.#signInMenu.target;
    return html`<md-menu
      class="acp-agent-card__sign-in-menu"
      placement="bottom-end"
      aria-label=${agent ? `Sign in to ${agent.name}` : 'Sign in'}
      @select=${this.#signInMenu.onSelect}
      @closed=${this.#signInMenu.onClosed}
    >
      ${agents.ownSignIns(agent?.signIn?.methods ?? []).map(
        (method) => html`<md-menu-item class="acp-agent-card__menu-item" value=${method.id}>
          ${method.name}
          ${method.description ? html`<span slot="supporting-text">${method.description}</span>` : nothing}
        </md-menu-item>`,
      )}
    </md-menu>`;
  }

  render() {
    const agent = this.agent;
    if (!agent) return nothing;
    return html`${agent.enabled ? this.#renderOn(agent) : this.#renderOff(agent)} ${this.#renderMenu()} ${this.#renderSignInMenu()}`;
  }
}

customElements.define('acp-agent-card', AcpAgentCard);
