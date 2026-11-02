import { LitElement, html, nothing } from 'lit';
import '@symblight/wc-material/button';
import '@symblight/wc-material/dialog';
import '@symblight/wc-material/progress-circular';
import styles from './github-sign-in.css?inline';

/** @typedef {import('../../hooks/github/types.js').GithubSignIn} GithubSignIn */

const DEVICE_URL = 'https://github.com/login/device';
const INSTALL_URL = 'https://cli.github.com';

/**
 * @tag acp-github-sign-in
 * @summary Dialog for signing in to GitHub through the GitHub CLI: the one-time code to enter in the browser, why it failed, or how to install the CLI; closed while idle.
 * @fires acp-github-sign-in `null` Try again, or Check again after installing the CLI.
 * @fires acp-github-sign-in-cancel `null` Cancel or Close.
 * @fires acp-github-open `{ url }` A page to open in the browser.
 * @fires acp-github-copy `{ text }`
 */
export class AcpGithubSignIn extends LitElement {
  static properties = {
    state: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {GithubSignIn | null} */
    this.state = null;
  }

  get #dialog() {
    return /** @type {HTMLElementTagNameMap['md-dialog']} */ (this.renderRoot.querySelector('md-dialog'));
  }

  updated() {
    const shown = this.state !== null && this.state.phase !== 'idle';
    if (shown && !this.#dialog.open) void this.#dialog.show();
    else if (!shown && this.#dialog.open) this.#dialog.close();
  }

  /**
   * @param {string} event
   * @param {unknown} [detail]
   */
  #emit(event, detail = null) {
    this.dispatchEvent(new CustomEvent(event, { detail, bubbles: true, composed: true }));
  }

  // The native <dialog> closes itself on Escape without telling the app.
  /** @param {KeyboardEvent} e */
  #onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.#emit('acp-github-sign-in-cancel');
    }
  };

  /** @param {GithubSignIn} state */
  #renderBody(state) {
    switch (state.phase) {
      case 'noCli':
        return html`<p class="acp-github-sign-in__text">Brama uses the GitHub CLI to sign in to GitHub. It isn’t installed.</p>
          ${state.installCommand ? html`<code class="acp-github-sign-in__code acp-github-sign-in__code_command">${state.installCommand}</code>` : nothing}`;
      case 'code':
        return html`<p class="acp-github-sign-in__text">Enter this code at github.com/login/device. The browser is opening there.</p>
          <code class="acp-github-sign-in__code">${state.code}</code>`;
      case 'failed':
        return html`<p class="acp-github-sign-in__text">${state.error}</p>`;
      default:
        return html`<p class="acp-github-sign-in__text acp-github-sign-in__text_waiting">
          <md-progress-circular class="acp-github-sign-in__spinner"></md-progress-circular>Starting the GitHub CLI…
        </p>`;
    }
  }

  /** @param {GithubSignIn} state */
  #renderActions(state) {
    const cancel = (/** @type {string} */ label) =>
      html`<md-button class="acp-github-sign-in__action" variant="text" @click=${() => this.#emit('acp-github-sign-in-cancel')}>${label}</md-button>`;
    switch (state.phase) {
      case 'noCli':
        return html`${cancel('Close')}
          <md-button class="acp-github-sign-in__action" variant="text" @click=${() => this.#emit('acp-github-sign-in')}>Check again</md-button>
          <md-button class="acp-github-sign-in__action" variant="filled" @click=${() => this.#emit('acp-github-open', { url: INSTALL_URL })}>Open install page</md-button>`;
      case 'code':
        return html`${cancel('Cancel')}
          <md-button class="acp-github-sign-in__action" variant="text" @click=${() => this.#emit('acp-github-copy', { text: state.code })}>Copy code</md-button>
          <md-button class="acp-github-sign-in__action" variant="filled" @click=${() => this.#emit('acp-github-open', { url: DEVICE_URL })}>Open github.com</md-button>`;
      case 'failed':
        return html`${cancel('Close')}
          <md-button class="acp-github-sign-in__action" variant="filled" @click=${() => this.#emit('acp-github-sign-in')}>Try again</md-button>`;
      default:
        return cancel('Cancel');
    }
  }

  render() {
    const state = this.state;
    return html`<md-dialog class="acp-github-sign-in__dialog" role="dialog" @keydown=${this.#onKeydown}>
      <h2 slot="headline" class="acp-github-sign-in__headline">Sign in to GitHub</h2>
      <div class="acp-github-sign-in__content">${state && state.phase !== 'idle' ? this.#renderBody(state) : nothing}</div>
      <div slot="footer" class="acp-github-sign-in__footer">${state && state.phase !== 'idle' ? this.#renderActions(state) : nothing}</div>
    </md-dialog>`;
  }
}

customElements.define('acp-github-sign-in', AcpGithubSignIn);
