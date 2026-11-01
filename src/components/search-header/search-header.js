import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import previewBelowIcon from '@material-design-icons/svg/outlined/horizontal_split.svg?raw';
import previewRightIcon from '@material-design-icons/svg/outlined/vertical_split.svg?raw';
import popoutIcon from '@material-design-icons/svg/outlined/view_sidebar.svg?raw';
import styles from './search-header.css?inline';

/** @typedef {import('../../hooks/search/types.js').SearchDialogPrefs} SearchDialogPrefs */

/** @type {{ value: SearchDialogPrefs['preview'], icon: string, label: string }[]} */
const PREVIEW_POSITIONS = [
  { value: 'bottom', icon: previewBelowIcon, label: 'Preview below' },
  { value: 'right', icon: previewRightIcon, label: 'Preview on the right' },
];

/**
 * @tag acp-search-header
 * @summary The search dialog's title with the preview placement buttons and the one that hands the search to the panel.
 * @fires acp-search-header-preview `{ position }` a preview placement button pressed
 * @fires acp-search-header-popout the Open in panel button pressed
 */
export class AcpSearchHeader extends LitElement {
  static properties = {
    previewPosition: { type: String, attribute: 'preview-position' },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {SearchDialogPrefs['preview']} */
    this.previewPosition = 'bottom';
  }

  /**
   * @param {string} type
   * @param {object} [detail]
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  render() {
    return html`<h2 class="acp-search-header__title">Search in files</h2>
      ${PREVIEW_POSITIONS.map(({ value, icon, label }) => {
        const id = `acp-search-header-preview-${value}`;
        const pressed = this.previewPosition === value;
        return html`<md-icon-button
            id=${id}
            class="acp-search-header__button"
            ?selected=${pressed}
            aria-label=${label}
            aria-pressed=${pressed ? 'true' : 'false'}
            @click=${() => this.#emit('acp-search-header-preview', { position: value })}
          >
            <md-icon class="acp-search-header__icon">${unsafeSVG(icon)}</md-icon>
          </md-icon-button>
          <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
      })}
      <md-icon-button
        id="acp-search-header-popout"
        class="acp-search-header__button"
        aria-label="Open in panel"
        @click=${() => this.#emit('acp-search-header-popout')}
      >
        <md-icon class="acp-search-header__icon">${unsafeSVG(popoutIcon)}</md-icon>
      </md-icon-button>
      <md-tooltip for="acp-search-header-popout" show-delay="800">Open in panel</md-tooltip>`;
  }
}

customElements.define('acp-search-header', AcpSearchHeader);
