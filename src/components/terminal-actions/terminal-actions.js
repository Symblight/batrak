import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import removeIcon from '@material-design-icons/svg/outlined/remove.svg?raw';
import styles from './terminal-actions.css?inline';

/**
 * @tag acp-terminal-actions
 * @summary The terminal panel's buttons at the end of its tab strip: a new terminal, and hide the panel.
 * @fires acp-terminal-new
 * @fires acp-terminal-hide
 */
export class AcpTerminalActions extends LitElement {
  static styles = styles;

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} icon
   * @param {string} event
   */
  #renderButton(id, label, icon, event) {
    return html`<md-icon-button
        id=${id}
        class="acp-terminal-actions__button"
        aria-label=${label}
        @click=${() => this.dispatchEvent(new CustomEvent(event, { bubbles: true, composed: true }))}
      >
        <md-icon class="acp-terminal-actions__icon">${unsafeSVG(icon)}</md-icon>
      </md-icon-button>
      <md-tooltip for=${id} show-delay="800" placement="top">${label}</md-tooltip>`;
  }

  render() {
    return html`${this.#renderButton('acp-terminal-actions-new', 'New terminal', addIcon, 'acp-terminal-new')}
    ${this.#renderButton('acp-terminal-actions-hide', 'Hide panel', removeIcon, 'acp-terminal-hide')}`;
  }
}

customElements.define('acp-terminal-actions', AcpTerminalActions);
