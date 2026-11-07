import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/chips';
import '@symblight/wc-material/icon';
import forkRightIcon from '@material-design-icons/svg/outlined/fork_right.svg?raw';
import styles from './compare-chip.css?inline';

/**
 * @tag acp-compare-chip
 * @summary Says the Changes views show a branch's diff, and which; its × goes back to local changes. Says why a refresh failed, if one did.
 * @fires acp-compare-pick `{ branch: null }` Its × was pressed.
 */
export class AcpCompareChip extends LitElement {
  static properties = {
    target: { attribute: false },
    refreshError: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} The branch as picked: `main`, `origin/main`. */
    this.target = '';
    /** @type {string | null} */
    this.refreshError = null;
  }

  #onRemove() {
    this.dispatchEvent(new CustomEvent('acp-compare-pick', { detail: { branch: null }, bubbles: true, composed: true }));
  }

  render() {
    return html`<md-input-chip class="acp-compare-chip__chip" removable .selected=${live(false)} @remove=${this.#onRemove}>
        <md-icon slot="leading-icon" class="acp-compare-chip__icon">${unsafeSVG(forkRightIcon)}</md-icon>
        <span class="acp-compare-chip__label" title=${this.target}>Diff to ${this.target}</span>
      </md-input-chip>
      ${this.refreshError
        ? html`<span class="acp-compare-chip__error" role="status" title=${this.refreshError}>Couldn’t refresh: ${this.refreshError}</span>`
        : nothing}`;
  }
}

customElements.define('acp-compare-chip', AcpCompareChip);
