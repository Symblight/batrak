import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/tooltip';
import groupedIcon from '@material-design-icons/svg/outlined/account_tree.svg?raw';
import flatIcon from '@material-design-icons/svg/outlined/view_list.svg?raw';
import styles from './search-view-picker.css?inline';

/** @typedef {import('../../models/types/types.js').SearchDialogPrefs} SearchDialogPrefs */

/** @type {{ value: SearchDialogPrefs['view'], icon: string, label: string }[]} */
const VIEWS = [
  { value: 'grouped', icon: groupedIcon, label: 'Group by file' },
  { value: 'flat', icon: flatIcon, label: 'Flat list' },
];

/**
 * @tag acp-search-view-picker
 * @summary Group by file or Flat list for search results; the host owns the choice.
 * @fires acp-search-view-pick `{ view }` the other view's button pressed
 */
export class AcpSearchViewPicker extends LitElement {
  static properties = {
    view: { type: String },
  };

  static styles = styles;

  constructor() {
    super();
    const internals = this.attachInternals();
    internals.role = 'radiogroup';
    internals.ariaLabel = 'View';
    /** @type {SearchDialogPrefs['view']} */
    this.view = 'grouped';
  }

  /** @param {SearchDialogPrefs['view']} view */
  #pick(view) {
    if (view !== this.view) this.dispatchEvent(new CustomEvent('acp-search-view-pick', { detail: { view }, bubbles: true, composed: true }));
  }

  render() {
    return VIEWS.map(({ value, icon, label }) => {
      const id = `acp-search-view-picker-${value}`;
      const checked = this.view === value;
      return html`<md-icon-button
          id=${id}
          class="acp-search-view-picker__button"
          ?selected=${checked}
          role="radio"
          aria-label=${label}
          aria-checked=${checked ? 'true' : 'false'}
          @click=${() => this.#pick(value)}
        >
          <md-icon class="acp-search-view-picker__icon">${unsafeSVG(icon)}</md-icon>
        </md-icon-button>
        <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
    });
  }
}

customElements.define('acp-search-view-picker', AcpSearchViewPicker);
