import { LitElement, html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import boltIcon from '@material-design-icons/svg/outlined/bolt.svg?raw';
import checklistIcon from '@material-design-icons/svg/outlined/checklist.svg?raw';
import handIcon from '@material-design-icons/svg/outlined/front_hand.svg?raw';
import shieldIcon from '@material-design-icons/svg/outlined/shield.svg?raw';
import warningIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import { composer } from '../../hooks/composer/composer.js';
import styles from './mode-picker.css?inline';

/** @typedef {import('../../hooks/composer/types.js').ConfigOptionValue} ConfigOptionValue */
/** @typedef {import('../../hooks/composer/types.js').ConfigOption} ConfigOption */

/** @typedef {import('../../hooks/composer/types.js').ModeRisk} ModeRisk */

/** Each risk's icon; a value its agent's crate didn't tag gets the shield. */
const RISK_ICONS = { plan: checklistIcon, neutral: handIcon, agent: boltIcon, full: warningIcon };

/**
 * How risky a mode is decides its icon and color: the risk the backend tagged it with.
 * @param {ConfigOptionValue | undefined} value
 * @returns {{ icon: string, risk: ModeRisk }}
 */
function lookOf(value) {
  return value?.risk ? { icon: RISK_ICONS[value.risk], risk: value.risk } : { icon: shieldIcon, risk: 'neutral' };
}

/**
 * @tag acp-mode-picker
 * @summary The composer's permission chip (ACP config options of category `mode` and `permissions`) and its menu; absent when the agent has neither.
 * @fires acp-config-option `{ configId, value }`
 */
export class AcpModePicker extends LitElement {
  static properties = {
    options: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly ConfigOption[]} The session's config options. */
    this.options = [];
  }

  /**
   * @param {ConfigOption} option The value's.
   * @param {ConfigOptionValue} value
   * @param {boolean} withIcon Mode values show how risky they are; permissions values don't.
   */
  #renderItem(option, value, withIcon) {
    const { icon, risk } = lookOf(value);
    const description = value.description && value.description !== value.name ? value.description : null;
    return html`
      <md-menu-item
        class=${classMap({ 'acp-mode-picker__item': true, 'acp-mode-picker__item_danger': withIcon && risk === 'full' })}
        value=${value.value}
        data-config=${option.id}
        ?selected=${value.value === option.currentValue}
      >
        ${withIcon ? html`<md-icon slot="leading">${unsafeSVG(icon)}</md-icon>` : nothing}
        ${value.name}
        ${description ? html`<span slot="supporting-text">${description}</span>` : nothing}
      </md-menu-item>
    `;
  }

  /** @param {ConfigOption} mode */
  #renderModeGroups(mode) {
    // Full access stands apart: a gap separates the risky choice from the usual ones.
    const usual = mode.options.filter((v) => lookOf(v).risk !== 'full');
    const risky = mode.options.filter((v) => lookOf(v).risk === 'full');
    return html`
      <md-menu-group label=${mode.name}>${usual.map((v) => this.#renderItem(mode, v, true))}</md-menu-group>
      ${risky.length ? html`<md-item-group>${risky.map((v) => this.#renderItem(mode, v, true))}</md-item-group>` : nothing}
    `;
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { item } = /** @type {CustomEvent<{ value: string, item: HTMLElement }>} */ (e).detail;
    const option = this.options.find((o) => o.id === item.dataset.config);
    const value = item.getAttribute('value') ?? '';
    if (!option || value === option.currentValue) return;
    const detail = { configId: option.id, value };
    this.dispatchEvent(new CustomEvent('acp-config-option', { detail, bubbles: true, composed: true }));
  };

  render() {
    const mode = composer.configOf(this.options, 'mode');
    const permissions = this.options.filter((o) => o.category === 'permissions');
    // With no mode, the first permissions option names the chip.
    const chip = mode ?? permissions[0];
    if (!chip) return nothing;
    const current = chip.options.find((v) => v.value === chip.currentValue) ?? chip.options[0];
    const { icon, risk } = lookOf(mode ? current : undefined);
    const label = mode ? (current?.name ?? '') : `${chip.name}: ${current?.name ?? ''}`;
    const hint = [mode, ...permissions]
      .filter((o) => o !== null)
      .map((o) => `${o.name}: ${o.options.find((v) => v.value === o.currentValue)?.name ?? ''}`)
      .join(' · ');
    return html`
      <md-button
        id="acp-mode-picker-button"
        class="acp-mode-picker__button acp-mode-picker__button_${risk}"
        variant=${risk === 'neutral' ? 'outlined' : 'tonal'}
      >
        <md-icon slot="icon" class="acp-mode-picker__icon">${unsafeSVG(icon)}</md-icon>
        <span class="acp-mode-picker__label">${label}</span>
        <md-icon class="acp-mode-picker__arrow">${unsafeSVG(arrowIcon)}</md-icon>
      </md-button>
      <md-tooltip for="acp-mode-picker-button" show-delay="800">${hint}</md-tooltip>
      <md-menu
        class="acp-mode-picker__menu"
        for="acp-mode-picker-button"
        placement="top-end"
        focus-on-open="selected"
        @select=${this.#onSelect}
      >
        ${mode ? this.#renderModeGroups(mode) : nothing}
        ${permissions.map(
          (option) => html`
            <md-menu-group label=${option.name}>${option.options.map((v) => this.#renderItem(option, v, false))}</md-menu-group>
          `,
        )}
      </md-menu>
    `;
  }
}

customElements.define('acp-mode-picker', AcpModePicker);
