import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/shadow';
import '@symblight/wc-material/tooltip';
import chevronLeftIcon from '@material-design-icons/svg/outlined/chevron_left.svg?raw';
import chevronRightIcon from '@material-design-icons/svg/outlined/chevron_right.svg?raw';
import styles from './acp-comment-bar.css?inline';

/** @typedef {import('../../models/types/types.js').QueuedComment} QueuedComment */

/**
 * @tag acp-comment-bar
 * @summary Floating bar over the editors: steps through the active tab's agent comments (one file, or every diff in Changes); Send to agent moves them into the chat's composer.
 * @fires acp-comment-focus `{ path, threadId }` The arrows stepped to a comment.
 * @fires acp-comments-send `null`
 */
export class AcpCommentBar extends LitElement {
  static properties = {
    comments: { attribute: false },
    index: { state: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {readonly QueuedComment[]} The active tab's comments. */
    this.comments = [];
    /** @type {number} The comment the arrows stepped to, in `comments`. */
    this.index = 0;
  }

  /**
   * @param {string} type
   * @param {object | null} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  willUpdate() {
    const count = this.comments.length;
    this.hidden = count === 0;
    this.index = Math.min(this.index, Math.max(count - 1, 0));
  }

  /** @param {number} step `1` or `-1`; wraps around. */
  #step(step) {
    const queued = this.comments;
    if (!queued.length) return;
    this.index = (this.index + step + queued.length) % queued.length;
    const { path, threadId } = queued[this.index];
    this.#emit('acp-comment-focus', { path, threadId });
  }

  render() {
    const count = this.comments.length;
    if (!count) return nothing;
    return html`
      <md-shadow level="3"></md-shadow>
      <md-icon-button id="acp-comment-bar-previous" class="acp-comment-bar__nav" aria-label="Previous comment" @click=${() => this.#step(-1)}>
        <md-icon class="acp-comment-bar__nav-icon">${unsafeSVG(chevronLeftIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-comment-bar-previous" show-delay="800">Previous</md-tooltip>
      <span class="acp-comment-bar__position" aria-live="polite">
        ${this.index + 1}/${count} ${count === 1 ? 'comment' : 'comments'}
      </span>
      <md-icon-button id="acp-comment-bar-next" class="acp-comment-bar__nav" aria-label="Next comment" @click=${() => this.#step(1)}>
        <md-icon class="acp-comment-bar__nav-icon">${unsafeSVG(chevronRightIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-comment-bar-next" show-delay="800">Next</md-tooltip>
      <md-button class="acp-comment-bar__send" variant="filled" @click=${() => this.#emit('acp-comments-send', null)}>
        Send to agent
      </md-button>
    `;
  }
}

customElements.define('acp-comment-bar', AcpCommentBar);
