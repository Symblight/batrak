import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import styles from './panel-header.css?inline';

/**
 * @typedef {object} PanelHeaderAction
 * @property {string} id What `acp-panel-header-action` names.
 * @property {string} icon SVG markup.
 * @property {string} label
 * @property {string} [tooltip] Defaults to `label`.
 * @property {boolean} [disabled]
 */

/**
 * @tag acp-panel-header
 * @summary A panel's title row, with icon actions shown while the panel is hovered or one of them has focus.
 * @fires acp-panel-header-action `{ id }`
 */
export class AcpPanelHeader extends LitElement {
  static properties = {
    heading: { type: String },
    actions: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.heading = '';
    /** @type {PanelHeaderAction[]} Icon buttons at the end. */
    this.actions = [];
  }

  /** @param {string} id */
  #onAction(id) {
    this.dispatchEvent(new CustomEvent('acp-panel-header-action', { detail: { id }, bubbles: true, composed: true }));
  }

  render() {
    return html`<h2 class="acp-panel-header__title">${this.heading}</h2>
      ${repeat(
        this.actions,
        (action) => action.id,
        (action) => {
          const id = `acp-panel-header-action-${action.id}`;
          return html`<md-icon-button
              id=${id}
              class="acp-panel-header__action"
              aria-label=${action.label}
              ?disabled=${action.disabled}
              @click=${() => this.#onAction(action.id)}
            >
              <md-icon class="acp-panel-header__action-icon">${unsafeSVG(action.icon)}</md-icon>
            </md-icon-button>
            <md-tooltip for=${id} show-delay="800">${action.tooltip ?? action.label}</md-tooltip>`;
        },
      )}`;
  }
}

customElements.define('acp-panel-header', AcpPanelHeader);
