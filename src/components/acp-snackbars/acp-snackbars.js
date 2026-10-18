import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/snackbar';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import warningIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import infoIcon from '@material-design-icons/svg/outlined/info.svg?raw';
import styles from './acp-snackbars.css?inline';

/** @typedef {import('../../models/types.js').Notice} Notice */
/** @typedef {import('../../models/types.js').NoticeLevel} NoticeLevel */

/** @type {Record<NoticeLevel, string>} */
const ICONS = { error: errorIcon, warn: warningIcon, info: infoIcon };

/**
 * @tag acp-snackbars
 * @summary Stack of notice snackbars (backend warnings, failed actions), newest at the bottom.
 * @fires acp-notice-dismiss `{ id }`
 * @fires acp-notices-hold `{ held }` While the pointer is over the stack.
 */
export class AcpSnackbars extends LitElement {
  static properties = {
    notices: { attribute: false },
  };

  static styles = styles;

  #onPointerEnter = () => this.#emit('acp-notices-hold', { held: true });
  #onPointerLeave = () => this.#emit('acp-notices-hold', { held: false });

  constructor() {
    super();
    /** @type {Notice[]} */
    this.notices = [];
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointerenter', this.#onPointerEnter);
    this.addEventListener('pointerleave', this.#onPointerLeave);
  }

  disconnectedCallback() {
    this.removeEventListener('pointerenter', this.#onPointerEnter);
    this.removeEventListener('pointerleave', this.#onPointerLeave);
    super.disconnectedCallback();
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @param {Notice} notice */
  #renderNotice(notice) {
    return html`<md-snackbar
      class="acp-snackbars__snackbar acp-snackbars__snackbar_${notice.level}"
      show-close
      close-label="Dismiss"
      @close=${() => this.#emit('acp-notice-dismiss', { id: notice.id })}
    >
      <span class="acp-snackbars__content">
        <md-icon class="acp-snackbars__icon">${unsafeSVG(ICONS[notice.level])}</md-icon>
        <span class="acp-snackbars__message">${notice.message}</span>
        ${notice.count > 1 ? html`<span class="acp-snackbars__count">×${notice.count}</span>` : nothing}
      </span>
    </md-snackbar>`;
  }

  render() {
    return repeat(this.notices, (notice) => notice.id, (notice) => this.#renderNotice(notice));
  }
}

customElements.define('acp-snackbars', AcpSnackbars);
