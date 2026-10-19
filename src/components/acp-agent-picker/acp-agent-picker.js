import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import thinkingIcon from '@material-design-icons/svg/outlined/psychology.svg?raw';
import { configOf, currentName } from '../../models/config-options.js';
import styles from './acp-agent-picker.css?inline';

/** @typedef {import('../../models/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../../models/types.js').ConfigOption} ConfigOption */
/** @typedef {import('../../models/types.js').CatalogAgent} CatalogAgent */
/** @typedef {import('../../models/types.js').ComposerState} ComposerState */

/**
 * @tag acp-agent-picker
 * @summary The composer's agent · model · thinking button and its menu; the agent is fixed once the session started.
 * @fires acp-agent-select `{ agentId }`
 * @fires acp-config-option `{ agentId, configId, value }` A model or level, of that agent (picked first).
 * @fires acp-agents-file-open `null`
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
    /** @type {readonly CatalogAgent[]} Every agent the project can run. */
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
   * One menu group per config option the agent sends, except the permission mode (its own chip).
   * Items name their agent: picking another agent's model switches to that agent first.
   * @param {string} agentId
   * @param {readonly ConfigOption[]} options
   * @param {boolean} current Whether these are the session's options; others show no selection.
   */
  #renderConfigGroups(agentId, options, current) {
    return options
      .filter((o) => o.category !== 'mode')
      .map(
        (option) => html`
          <md-menu-group label=${option.name}>
            ${option.options.map(
              (v) => html`
                <md-menu-item
                  class="acp-agent-picker__item"
                  value=${v.value}
                  data-agent=${agentId}
                  data-config=${option.id}
                  ?selected=${current && v.value === option.currentValue}
                >
                  ${v.name}
                  ${v.description ? html`<span slot="supporting-text">${v.description}</span>` : nothing}
                </md-menu-item>
              `,
            )}
          </md-menu-group>
        `,
      );
  }

  /**
   * @param {AgentInfo} agent
   * @param {string} slot
   */
  #renderGlyph(agent, slot = 'leading') {
    return html`<span class="acp-agent-picker__glyph" slot=${slot}>${agent.glyph}</span>`;
  }

  /** @param {ComposerState} composer */
  #renderAgentsMenu({ agentId, configOptions }) {
    return html`
      <md-menu-group label="Agent">
        ${this.agents.map((agent) => {
          const current = agent.id === agentId;
          const options = current ? configOptions : agent.configOptions;
          return html`
            <md-menu-item class="acp-agent-picker__item" value=${agent.id} ?selected=${current}>
              ${this.#renderGlyph(agent)} ${agent.name}
              <span slot="supporting-text">${currentName(configOf(options, 'model')) ?? 'No models reported yet'}</span>
              ${options.some((o) => o.category !== 'mode')
                ? html`<md-menu slot="submenu" class="acp-agent-picker__menu" aria-label=${agent.name}>
                    ${this.#renderConfigGroups(agent.id, options, current)}
                  </md-menu>`
                : nothing}
            </md-menu-item>
          `;
        })}
      </md-menu-group>
      <md-item-group>
        <md-menu-item class="acp-agent-picker__item" value="" data-action="add-agent">
          <md-icon slot="leading">${unsafeSVG(addIcon)}</md-icon>
          Add ACP agent…
        </md-menu-item>
      </md-item-group>
    `;
  }

  /**
   * @param {ComposerState} composer
   * @param {AgentInfo} agent
   */
  #renderSessionMenu({ agentId, configOptions }, agent) {
    return html`
      <md-item-group>
        <md-menu-item class="acp-agent-picker__item" disabled>
          ${this.#renderGlyph(agent)} ${agent.name}
          <span slot="supporting-text">Fixed for this session</span>
          <md-icon slot="trailing" class="acp-agent-picker__lock">${unsafeSVG(lockIcon)}</md-icon>
        </md-menu-item>
      </md-item-group>
      ${this.#renderConfigGroups(agentId, configOptions, true)}
    `;
  }

  /** Picks already handled: a submenu's pick reaches the outer menu twice, both with the same detail. */
  #handled = new WeakSet();

  /** The outermost menu re-dispatches every pick, its submenus' too, with itself as the target. */
  #onSelect = (/** @type {Event} */ e) => {
    const { detail } = /** @type {CustomEvent<{ value: string, item: HTMLElement }>} */ (e);
    if (e.target !== e.currentTarget || this.#handled.has(detail)) return;
    this.#handled.add(detail);
    const { item } = detail;
    if (item.dataset.action === 'add-agent') {
      this.#emit('acp-agents-file-open', null);
      return;
    }
    const { agent, config } = item.dataset;
    if (!agent || !config) {
      // An agent row with no options to pick from yet: picking the row picks the agent.
      const value = item.getAttribute('value');
      if (value) this.#emit('acp-agent-select', { agentId: value });
      return;
    }
    this.#emit('acp-config-option', { agentId: agent, configId: config, value: item.getAttribute('value') ?? '' });
  };

  render() {
    const composer = this.composer;
    const agent = this.agent;
    if (!composer || !agent) return nothing;
    const { configOptions, started } = composer;
    const model = currentName(configOf(configOptions, 'model'));
    const level = currentName(configOf(configOptions, 'thought_level'));
    const title = [agent.name, model, level].filter(Boolean).join(' · ');
    return html`
      <md-button id="acp-agent-picker-button" class="acp-agent-picker__button" variant="text" title=${title}>
        ${this.#renderGlyph(agent, 'icon')}
        <span class="acp-agent-picker__label">
          <span class="acp-agent-picker__agent">${agent.name}${model ? ' ·' : ''}</span>
          <span class="acp-agent-picker__model">${model}</span>
          ${level
            ? html`<span class="acp-agent-picker__level">
                <md-icon class="acp-agent-picker__level-icon">${unsafeSVG(thinkingIcon)}</md-icon>${level}
              </span>`
            : nothing}
          <md-icon class="acp-agent-picker__arrow">${unsafeSVG(arrowIcon)}</md-icon>
        </span>
      </md-button>
      <md-menu
        class="acp-agent-picker__menu"
        for="acp-agent-picker-button"
        placement="top-start"
        focus-on-open="selected"
        @select=${this.#onSelect}
      >
        ${started ? this.#renderSessionMenu(composer, agent) : this.#renderAgentsMenu(composer)}
      </md-menu>
    `;
  }
}

customElements.define('acp-agent-picker', AcpAgentPicker);
