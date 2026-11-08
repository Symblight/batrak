import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import agentIcon from '@material-design-icons/svg/outlined/smart_toy.svg?raw';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import '../agent-icon/agent-icon.js';
import styles from './agent-picker.css?inline';

/** @typedef {import('../../hooks/agents/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../../hooks/agents/types.js').CatalogAgent} CatalogAgent */
/** @typedef {import('../../hooks/composer/types.js').ComposerState} ComposerState */

/**
 * @tag acp-agent-picker
 * @summary A draft's agent button and its menu; nothing once the session started, since its agent is fixed.
 * @fires acp-agent-select `{ agentId }`
 * @fires acp-agent-add-open `null` Add ACP agent…: the Agents tab opens with the add form.
 */
export class AcpAgentPicker extends LitElement {
  static properties = {
    composer: { attribute: false },
    agents: { attribute: false },
    agent: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {ComposerState | null} The active session's. */
    this.composer = null;
    /** @type {readonly CatalogAgent[]} Every agent of the project; `off` ones aren't offered. */
    this.agents = [];
    /** @type {AgentInfo | null} The composer's agent. */
    this.agent = null;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * @param {AgentInfo} agent
   * @param {string} slot
   */
  #renderGlyph(agent, slot = 'leading') {
    return html`<acp-agent-icon class="acp-agent-picker__glyph" slot=${slot} .agent=${agent}></acp-agent-icon>`;
  }

  /** The agents a draft can pick: those not turned off. */
  get #offered() {
    return this.agents.filter((a) => !a.off);
  }

  /** @param {string | null} agentId */
  #renderAgentsMenu(agentId) {
    const offered = this.#offered;
    return html`
      ${offered.length
        ? html`<md-menu-group label="Agent">
            ${offered.map(
              (agent) => html`
                <md-menu-item class="acp-agent-picker__item" value=${agent.id} ?selected=${agent.id === agentId}>
                  ${this.#renderGlyph(agent)} ${agent.name}
                  ${agent.signIn ? html`<span slot="supporting-text">Needs sign-in</span>` : nothing}
                </md-menu-item>
              `,
            )}
          </md-menu-group>`
        : nothing}
      <md-item-group>
        <md-menu-item class="acp-agent-picker__item" value="" data-action="add-agent">
          <md-icon slot="leading">${unsafeSVG(addIcon)}</md-icon>
          Add ACP agent…
        </md-menu-item>
      </md-item-group>
    `;
  }

  /** The menu re-dispatches every pick with itself as the target; the items' own bubble too. */
  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { item } = /** @type {CustomEvent<{ value: string, item: HTMLElement }>} */ (e).detail;
    if (item.dataset.action === 'add-agent') {
      this.#emit('acp-agent-add-open', null);
      return;
    }
    const agentId = item.getAttribute('value');
    if (agentId && agentId !== this.composer?.agentId) this.#emit('acp-agent-select', { agentId });
  };

  /** With no agent configured, the button only leads to adding one. */
  #renderAddLabel() {
    return html`
      <md-icon slot="icon" class="acp-agent-picker__agent-icon">${unsafeSVG(agentIcon)}</md-icon>
      <span class="acp-agent-picker__label">
        <span class="acp-agent-picker__agent">Add agent</span>
        <md-icon class="acp-agent-picker__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </span>
    `;
  }

  /** @param {AgentInfo} agent */
  #renderAgentLabel(agent) {
    return html`
      ${this.#renderGlyph(agent, 'icon')}
      <span class="acp-agent-picker__label">
        <span class="acp-agent-picker__agent">${agent.name}${agent.removed ? ' (removed)' : agent.off ? ' (off)' : ''}</span>
        <md-icon class="acp-agent-picker__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </span>
    `;
  }

  render() {
    const composer = this.composer;
    const agent = this.agent;
    if (!composer || composer.started) return nothing;
    const title = agent ? `Agent: ${agent.name}` : 'Add an ACP agent';
    // One button whatever it shows: md-menu finds its `for` anchor only when it connects.
    return html`
      <md-button id="acp-agent-picker-button" class="acp-agent-picker__button" variant="text">
        ${agent ? this.#renderAgentLabel(agent) : this.#renderAddLabel()}
      </md-button>
      <md-tooltip for="acp-agent-picker-button" show-delay="800">${title}</md-tooltip>
      <md-menu
        class="acp-agent-picker__menu"
        for="acp-agent-picker-button"
        placement="top-start"
        focus-on-open="selected"
        @select=${this.#onSelect}
      >
        ${this.#renderAgentsMenu(composer.agentId)}
      </md-menu>
    `;
  }
}

customElements.define('acp-agent-picker', AcpAgentPicker);
