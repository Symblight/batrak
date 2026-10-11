import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/snackbar';
import errorIcon from '@material-design-icons/svg/outlined/error.svg?raw';
import warningIcon from '@material-design-icons/svg/outlined/warning.svg?raw';
import infoIcon from '@material-design-icons/svg/outlined/info.svg?raw';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $notices, dismissNotice, holdNotices } from '../../stores/notices.js';
import styles from './acp-snackbars.css?inline';

/** @typedef {import('../../models/types.js').Notice} Notice */
/** @typedef {import('../../models/types.js').NoticeLevel} NoticeLevel */

/** @type {Record<NoticeLevel, string>} */
const ICONS = { error: errorIcon, warn: warningIcon, info: infoIcon };

/**
 * @tag acp-snackbars
 * @summary Stack of `$notices` snackbars (backend warnings, failed actions), newest at the bottom.
 */
export class AcpSnackbars extends LitElement {
  static styles = styles;

  #notices = new StoreController(this, { store: $notices });

  #onPointerEnter = () => holdNotices(true);
  #onPointerLeave = () => holdNotices(false);

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

  /** @param {Notice} notice */
  #renderNotice(notice) {
    return html`<md-snackbar
      class="acp-snackbars__snackbar acp-snackbars__snackbar_${notice.level}"
      show-close
      close-label="Dismiss"
      @close=${() => dismissNotice(notice.id)}
    >
      <span class="acp-snackbars__content">
        <md-icon class="acp-snackbars__icon">${unsafeSVG(ICONS[notice.level])}</md-icon>
        <span class="acp-snackbars__message">${notice.message}</span>
        ${notice.count > 1 ? html`<span class="acp-snackbars__count">×${notice.count}</span>` : nothing}
      </span>
    </md-snackbar>`;
  }

  render() {
    return repeat(this.#notices.value, (notice) => notice.id, (notice) => this.#renderNotice(notice));
  }
}

customElements.define('acp-snackbars', AcpSnackbars);
