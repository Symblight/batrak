import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/progress-circular';
import '@symblight/wc-material/tooltip';
import arrowIcon from '@material-design-icons/svg/outlined/arrow_drop_down.svg?raw';
import thinkingIcon from '@material-design-icons/svg/outlined/psychology.svg?raw';
import { composer } from '../../hooks/composer/composer.js';
import styles from './model-picker.css?inline';

/** @typedef {import('../../models/types/types.js').ConfigOption} ConfigOption */
/** @typedef {import('../../models/types/types.js').ConfigOptionValue} ConfigOptionValue */
/** @typedef {import('../../models/types/types.js').AgentOptionsStatus} AgentOptionsStatus */

/** Categories with a chip of their own (`<acp-mode-picker>`). */
const ELSEWHERE = new Set(['mode', 'permissions']);

/**
 * @tag acp-model-picker
 * @summary The composer's model · thinking button and its menu: the agent's config options but mode and permissions.
 * @fires acp-config-option `{ configId, value }`
 */
export class AcpModelPicker extends LitElement {
  static properties = {
    options: { attribute: false },
    status: { attribute: false },
    signIn: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly ConfigOption[]} The composer's config options. */
    this.options = [];
    /** @type {AgentOptionsStatus | null} Whether the agent's options are being asked for, or that failed. */
    this.status = null;
    /** @type {boolean} The agent asked to sign in. */
    this.signIn = false;
  }

  /** The options this picker offers. */
  get #shown() {
    return this.options.filter((o) => !ELSEWHERE.has(o.category ?? ''));
  }

  /**
   * @param {ConfigOptionValue} value
   * @param {ConfigOption} option The value's.
   */
  #renderItem(value, option) {
    const description = value.description && value.description !== value.name ? value.description : null;
    return html`
      <md-menu-item
        class="acp-model-picker__item"
        value=${value.value}
        data-config=${option.id}
        ?selected=${value.value === option.currentValue}
      >
        ${value.name}
        ${description ? html`<span slot="supporting-text">${description}</span>` : nothing}
      </md-menu-item>
    `;
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return;
    const { item } = /** @type {CustomEvent<{ value: string, item: HTMLElement }>} */ (e).detail;
    const configId = item.dataset.config;
    const option = this.options.find((o) => o.id === configId);
    const value = item.getAttribute('value') ?? '';
    if (!option || value === option.currentValue) return;
    const detail = { configId: option.id, value };
    this.dispatchEvent(new CustomEvent('acp-config-option', { detail, bubbles: true, composed: true }));
  };

  #renderSpinner() {
    return html`<md-progress-circular class="acp-model-picker__spinner" aria-label="Loading models"></md-progress-circular>`;
  }

  /**
   * The button's content and tooltip while there's nothing to pick; null once there is.
   * @returns {{ label: string, hint: string, spinner: boolean } | null}
   */
  #emptyState() {
    if (this.#shown.length) return null;
    if (this.signIn) return { label: 'Sign in to load models', hint: 'The agent asked to sign in; its models show once it has', spinner: false };
    if (this.status === 'loading') return { label: 'Loading models…', hint: 'Asking the agent for its models', spinner: true };
    if (this.status === 'failed') {
      return { label: 'No models', hint: "Couldn't load models from the agent; they show once its session starts", spinner: false };
    }
    return null;
  }

  render() {
    const shown = this.#shown;
    const empty = this.#emptyState();
    if (!shown.length && !empty) return nothing;
    const modelOption = composer.configOf(shown, 'model');
    const levelOption = composer.configOf(shown, 'thought_level');
    // An agent with neither a model nor a level: its first option's value names the button.
    const model = composer.currentName(modelOption ?? (levelOption ? null : shown[0] ?? null));
    const level = composer.currentName(levelOption);
    const hint =
      empty?.hint ??
      shown
        .map((o) => [o.name, composer.currentName(o)])
        .filter(([, v]) => v)
        .map(([name, v]) => `${name}: ${v}`)
        .join(' · ');
    // One button whatever it shows: md-menu finds its `for` anchor only when it connects.
    return html`
      <md-button id="acp-model-picker-button" class="acp-model-picker__button" variant="text" ?disabled=${empty !== null}>
        <span class="acp-model-picker__label">
          ${empty
            ? html`${empty.spinner ? this.#renderSpinner() : nothing}<span class="acp-model-picker__model">${empty.label}</span>`
            : html`
                <span class="acp-model-picker__model">${model}</span>
                ${level
                  ? html`<span class="acp-model-picker__level">
                      <md-icon class="acp-model-picker__level-icon">${unsafeSVG(thinkingIcon)}</md-icon>${level}
                    </span>`
                  : nothing}
                ${this.status === 'loading' ? this.#renderSpinner() : nothing}
                <md-icon class="acp-model-picker__arrow">${unsafeSVG(arrowIcon)}</md-icon>
              `}
        </span>
      </md-button>
      <md-tooltip for="acp-model-picker-button" show-delay="800">${hint}</md-tooltip>
      <md-menu
        class="acp-model-picker__menu"
        for="acp-model-picker-button"
        placement="top-start"
        focus-on-open="selected"
        @select=${this.#onSelect}
      >
        ${shown.map(
          (option) => html`
            <md-menu-group label=${option.name}>${option.options.map((v) => this.#renderItem(v, option))}</md-menu-group>
          `,
        )}
      </md-menu>
    `;
  }
}

customElements.define('acp-model-picker', AcpModelPicker);
