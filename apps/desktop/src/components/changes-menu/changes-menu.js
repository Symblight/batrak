import { LitElement, html, nothing } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/menu';
import '@symblight/wc-material/tooltip';
import moreIcon from '@material-design-icons/svg/outlined/more_vert.svg?raw';
import refreshIcon from '@material-design-icons/svg/outlined/refresh.svg?raw';
import undoIcon from '@material-design-icons/svg/outlined/undo.svg?raw';
import styles from './changes-menu.css?inline';

/**
 * @tag acp-changes-menu
 * @summary The actions menu of a project's changes, in the Changes tab and the Changes pane: Rollback for the picked files, and Refresh.
 * @fires acp-changes-rollback `null` Its view asks first.
 * @fires acp-changes-refresh `null`
 */
export class AcpChangesMenu extends LitElement {
  static properties = {
    picked: { type: Number },
    readOnly: { type: Boolean, attribute: 'read-only', reflect: true },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {number} How many listed files are picked: Rollback is theirs. */
    this.picked = 0;
    /** @type {boolean} A branch's diff is shown, whose files aren't there to roll back: only Refresh. */
    this.readOnly = false;
  }

  #onSelect = (/** @type {Event} */ e) => {
    if (e.target !== e.currentTarget) return; // the item's own `select`; the menu dispatches it again
    const { value } = /** @type {CustomEvent<{ value: string }>} */ (e).detail;
    this.dispatchEvent(new CustomEvent(`acp-changes-${value}`, { detail: null, bubbles: true, composed: true }));
  };

  render() {
    return html`<md-icon-button id="more" class="acp-changes-menu__button" aria-label="More actions" aria-haspopup="menu">
        <md-icon class="acp-changes-menu__icon">${unsafeSVG(moreIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="more" show-delay="800">More actions</md-tooltip>
      <md-menu class="acp-changes-menu__menu" for="more" placement="bottom-end" aria-label="More actions" @select=${this.#onSelect}>
        ${this.readOnly
          ? nothing
          : html`<md-menu-item value="rollback" ?disabled=${this.picked === 0}>
              <md-icon slot="leading" class="acp-changes-menu__item-icon">${unsafeSVG(undoIcon)}</md-icon>
              Rollback
            </md-menu-item>`}
        <md-menu-item value="refresh">
          <md-icon slot="leading" class="acp-changes-menu__item-icon">${unsafeSVG(refreshIcon)}</md-icon>
          Refresh
        </md-menu-item>
      </md-menu>`;
  }
}

customElements.define('acp-changes-menu', AcpChangesMenu);
