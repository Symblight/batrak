import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import downloadIcon from '@material-design-icons/svg/outlined/download.svg?raw';
import loginIcon from '@material-design-icons/svg/outlined/login.svg?raw';
import styles from './pull-request-chip.css?inline';

/** @typedef {import('../../hooks/github/types.js').GithubSlot} GithubSlot */

/**
 * @tag acp-pull-request-chip
 * @summary The header's GitHub slot for a branch whose remote is on github.com: the way in while the GitHub CLI is missing or signed out; nothing otherwise.
 * @fires acp-github-sign-in `null`
 */
export class AcpPullRequestChip extends LitElement {
  static properties = {
    status: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GithubSlot} */
    this.status = 'hidden';
  }

  #onClick() {
    this.dispatchEvent(new CustomEvent('acp-github-sign-in', { detail: null, bubbles: true, composed: true }));
  }

  render() {
    const missing = this.status === 'noCli';
    if (!missing && this.status !== 'signedOut') return nothing;
    const label = missing ? 'Install GitHub CLI' : 'Sign in to GitHub';
    const tooltip = missing
      ? 'Brama uses the GitHub CLI to sign in to GitHub'
      : 'Sign in to GitHub in your browser, to see this branch’s pull request';
    return html`<button id="acp-pull-request-chip" class="acp-pull-request-chip__button" type="button" @click=${this.#onClick}>
        <md-icon class="acp-pull-request-chip__icon">${unsafeSVG(missing ? downloadIcon : loginIcon)}</md-icon>${label}
      </button>
      <md-tooltip for="acp-pull-request-chip" show-delay="800" placement="bottom">${tooltip}</md-tooltip>`;
  }
}

customElements.define('acp-pull-request-chip', AcpPullRequestChip);
