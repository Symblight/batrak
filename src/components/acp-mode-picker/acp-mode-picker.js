import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import boltIcon from '@material-design-icons/svg/outlined/bolt.svg?raw';
import checklistIcon from '@material-design-icons/svg/outlined/checklist.svg?raw';
import handIcon from '@material-design-icons/svg/outlined/front_hand.svg?raw';
import shieldIcon from '@material-design-icons/svg/outlined/shield.svg?raw';
import warningIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $composer, configOf, setConfigOption } from '../../stores/composer.js';
import styles from './acp-mode-picker.css?inline';

/** @typedef {import('../../models/types.js').ConfigOptionValue} ConfigOptionValue */

/**
 * How risky a mode is decides its chip's color; the agent names the modes, Brama knows a few ids.
 * @typedef {'neutral' | 'plan' | 'agent' | 'full'} ModeRisk
 */

/** @type {Record<string, { icon: string, risk: ModeRisk }>} */
const KNOWN_MODES = {
  plan: { icon: checklistIcon, risk: 'plan' },
  ask: { icon: handIcon, risk: 'neutral' },
  agent: { icon: boltIcon, risk: 'agent' },
  full: { icon: warningIcon, risk: 'full' },
};

/** @param {string} value */
function lookOf(value) {
  return KNOWN_MODES[value] ?? { icon: shieldIcon, risk: /** @type {ModeRisk} */ ('neutral') };
}

/**
 * @tag acp-mode-picker
 * @summary The composer's permission-mode chip (ACP config option of category `mode`) and its menu; absent when the agent has none.
 */
export class AcpModePicker extends LitElement {
  static styles = styles;

  #composer = new StoreController(this, { store: $composer });

  /** @param {ConfigOptionValue} value */
  #renderItem(value, selected = false) {
    const { icon, risk } = lookOf(value.value);
    return html`
      <md-menu-item
        class=${classMap({ 'acp-mode-picker__item': true, 'acp-mode-picker__item_danger': risk === 'full' })}
        value=${value.value}
        ?selected=${selected}
      >
        <md-icon slot="leading">${unsafeSVG(icon)}</md-icon>
        ${value.name}
        ${value.description ? html`<span slot="supporting-text">${value.description}</span>` : nothing}
      </md-menu-item>
    `;
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const mode = configOf(this.#composer.value.configOptions, 'mode');
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    if (mode && value !== mode.currentValue) setConfigOption(mode.id, value);
  };

  render() {
    const mode = configOf(this.#composer.value.configOptions, 'mode');
    if (!mode) return nothing;
    const current = mode.options.find((v) => v.value === mode.currentValue) ?? mode.options[0];
    const { icon, risk } = lookOf(current.value);
    // Full access stands apart: a gap separates the risky choice from the usual ones.
    const usual = mode.options.filter((v) => lookOf(v.value).risk !== 'full');
    const risky = mode.options.filter((v) => lookOf(v.value).risk === 'full');
    return html`
      <md-button
        id="acp-mode-picker-button"
        class="acp-mode-picker__button acp-mode-picker__button_${risk}"
        variant=${risk === 'neutral' ? 'outlined' : 'tonal'}
        title="${mode.name}: ${current.name}"
      >
        <md-icon slot="icon">${unsafeSVG(icon)}</md-icon>
        <span class="acp-mode-picker__label">${current.name}</span>
        <md-icon class="acp-mode-picker__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-menu
        class="acp-mode-picker__menu"
        for="acp-mode-picker-button"
        placement="top-end"
        focus-on-open="selected"
        @select=${this.#onSelect}
      >
        <md-menu-group label=${mode.name}>
          ${usual.map((v) => this.#renderItem(v, v.value === mode.currentValue))}
        </md-menu-group>
        ${risky.length
          ? html`<md-item-group>${risky.map((v) => this.#renderItem(v, v.value === mode.currentValue))}</md-item-group>`
          : nothing}
      </md-menu>
    `;
  }
}

customElements.define('acp-mode-picker', AcpModePicker);
