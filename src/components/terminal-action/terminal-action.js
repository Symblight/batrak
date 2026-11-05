import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import addIcon from '@material-design-icons/svg/outlined/add.svg?raw';
import removeIcon from '@material-design-icons/svg/outlined/remove.svg?raw';
import styles from './terminal-action.css?inline';

/** @type {Record<'new' | 'hide', { label: string, icon: string, event: string }>} */
const ACTIONS = {
  new: { label: 'New terminal', icon: addIcon, event: 'acp-terminal-new' },
  hide: { label: 'Hide panel', icon: removeIcon, event: 'acp-terminal-hide' },
};

/**
 * @tag acp-terminal-action
 * @summary One compact button of the terminal panel's tab strip: `new` (a new terminal, after the last tab) or `hide` (the panel, at the end of the row).
 * @fires acp-terminal-new
 * @fires acp-terminal-hide
 */
export class AcpTerminalAction extends LitElement {
  static properties = {
    action: { type: String, reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {'new' | 'hide'} */
    this.action = 'new';
  }

  render() {
    const { label, icon, event } = ACTIONS[this.action];
    return html`<md-icon-button
        id="acp-terminal-action"
        class="acp-terminal-action__button"
        aria-label=${label}
        @click=${() => this.dispatchEvent(new CustomEvent(event, { bubbles: true, composed: true }))}
      >
        <md-icon class="acp-terminal-action__icon">${unsafeSVG(icon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-terminal-action" show-delay="800" placement="top">${label}</md-tooltip>`;
  }
}

customElements.define('acp-terminal-action', AcpTerminalAction);
