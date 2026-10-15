import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import lockIcon from '@material-design-icons/svg/outlined/lock.svg?raw';
import thinkingIcon from '@material-design-icons/svg/outlined/psychology.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import {
  $composer,
  AGENTS,
  agentInfo,
  configOf,
  currentName,
  selectAgent,
  setConfigOption,
} from '../../stores/composer.js';
import { SETTINGS_TAB_ID, openTab } from '../../stores/editor.js';
import styles from './acp-agent-picker.css?inline';

/** @typedef {import('../../models/types.js').AgentInfo} AgentInfo */
/** @typedef {import('../../models/types.js').ConfigOption} ConfigOption */

/**
 * @tag acp-agent-picker
 * @summary The composer's agent · model · thinking button and its menu; the agent is fixed once the session started.
 */
export class AcpAgentPicker extends LitElement {
  static styles = styles;

  #composer = new StoreController(this, { store: $composer });

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

  /** @param {AgentInfo} agent */
  #renderGlyph(agent, slot = 'leading') {
    return html`<span class="acp-agent-picker__glyph" slot=${slot}>${agent.glyph}</span>`;
  }

  #renderAgentsMenu() {
    const { agentId, configOptions } = this.#composer.value;
    return html`
      <md-menu-group label="Agent">
        ${AGENTS.map((agent) => {
          const current = agent.id === agentId;
          const options = current ? configOptions : agent.configOptions;
          return html`
            <md-menu-item class="acp-agent-picker__item" value=${agent.id} ?selected=${current}>
              ${this.#renderGlyph(agent)} ${agent.name}
              <span slot="supporting-text">${currentName(configOf(options, 'model'))}</span>
              <md-menu slot="submenu" class="acp-agent-picker__menu" aria-label=${agent.name}>
                ${this.#renderConfigGroups(agent.id, options, current)}
              </md-menu>
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

  #renderSessionMenu() {
    const { agentId, configOptions } = this.#composer.value;
    const agent = agentInfo(agentId);
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
      openTab(SETTINGS_TAB_ID);
      return;
    }
    const { agent, config } = item.dataset;
    if (!agent || !config) return;
    selectAgent(agent);
    setConfigOption(config, /** @type {string} */ (item.getAttribute('value')));
  };

  render() {
    const { agentId, configOptions, started } = this.#composer.value;
    const agent = agentInfo(agentId);
    const model = currentName(configOf(configOptions, 'model'));
    const level = currentName(configOf(configOptions, 'thought_level'));
    const title = [agent.name, model, level].filter(Boolean).join(' · ');
    return html`
      <md-button id="acp-agent-picker-button" class="acp-agent-picker__button" variant="text" title=${title}>
        ${this.#renderGlyph(agent, 'icon')}
        <span class="acp-agent-picker__label">
          <span class="acp-agent-picker__agent">${agent.name} ·</span>
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
        ${started ? this.#renderSessionMenu() : this.#renderAgentsMenu()}
      </md-menu>
    `;
  }
}

customElements.define('acp-agent-picker', AcpAgentPicker);
