import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/shadow';
import chevronLeftIcon from '@material-design-icons/svg/outlined/chevron_left.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $tabComments, focusComment, sendToChat } from '../../stores/comments.js';
import styles from './acp-comment-bar.css?inline';

/**
 * @tag acp-comment-bar
 * @summary Floating bar over the editors: steps through the active tab's agent comments (one file, or every diff in Changes); Send to agent moves them into the chat's composer.
 */
export class AcpCommentBar extends LitElement {
  static properties = {
    index: { state: true },
  };

  static styles = styles;

  #queued = new StoreController(this, { store: $tabComments });

  constructor() {
    super();
    /** @type {number} The comment the arrows stepped to, in `$tabComments`. */
    this.index = 0;
  }

  willUpdate() {
    const count = this.#queued.value.length;
    this.hidden = count === 0;
    this.index = Math.min(this.index, Math.max(count - 1, 0));
  }

  /** @param {number} step `1` or `-1`; wraps around. */
  #step(step) {
    const queued = this.#queued.value;
    if (!queued.length) return;
    this.index = (this.index + step + queued.length) % queued.length;
    const { path, threadId } = queued[this.index];
    focusComment({ path, threadId });
  }

  render() {
    const count = this.#queued.value.length;
    if (!count) return nothing;
    return html`
      <md-shadow level="3"></md-shadow>
      <md-icon-button class="acp-comment-bar__nav" aria-label="Previous comment" title="Previous" @click=${() => this.#step(-1)}>
        <md-icon class="acp-comment-bar__nav-icon">${unsafeSVG(chevronLeftIcon)}</md-icon>
      </md-icon-button>
      <span class="acp-comment-bar__position" aria-live="polite">
        ${this.index + 1}/${count} ${count === 1 ? 'comment' : 'comments'}
      </span>
      <md-icon-button class="acp-comment-bar__nav" aria-label="Next comment" title="Next" @click=${() => this.#step(1)}>
        <md-icon class="acp-comment-bar__nav-icon">${unsafeSVG(chevronRightIcon)}</md-icon>
      </md-icon-button>
      <md-button class="acp-comment-bar__send" variant="filled" @click=${() => sendToChat(this.#queued.value)}>
        Send to agent
      </md-button>
    `;
  }
}

customElements.define('acp-comment-bar', AcpCommentBar);
