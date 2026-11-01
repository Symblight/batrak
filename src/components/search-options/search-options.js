import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon-button';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import caseIcon from '@material-design-icons/svg/outlined/text_fields.svg?raw';
import wordIcon from '@material-design-icons/svg/outlined/abc.svg?raw';
import regexIcon from '@material-design-icons/svg/outlined/emergency.svg?raw';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './search-options.css?inline';

/** @typedef {import('../../hooks/search/search.js').SearchOptionKey} SearchOptionKey */

/** @type {{ option: SearchOptionKey, icon: string, label: string, shortcut: import('../../hooks/shortcuts/shortcuts.js').ShortcutId }[]} */
const OPTIONS = [
  { option: 'caseSensitive', icon: caseIcon, label: 'Match case', shortcut: 'matchCase' },
  { option: 'wholeWord', icon: wordIcon, label: 'Match whole word', shortcut: 'wholeWord' },
  { option: 'regex', icon: regexIcon, label: 'Use regular expression', shortcut: 'regex' },
];

/**
 * @tag acp-search-options
 * @summary Match case, whole word and regex toggles of a search; the host owns their state.
 * @fires acp-search-option-toggle `{ option }` when a toggle is clicked
 */
export class AcpSearchOptions extends LitElement {
  static properties = {
    caseSensitive: { type: Boolean },
    wholeWord: { type: Boolean },
    regex: { type: Boolean },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {boolean} */
    this.caseSensitive = false;
    /** @type {boolean} */
    this.wholeWord = false;
    /** @type {boolean} */
    this.regex = false;
  }

  /** @param {SearchOptionKey} option */
  #toggle(option) {
    this.dispatchEvent(new CustomEvent('acp-search-option-toggle', { detail: { option }, bubbles: true, composed: true }));
  }

  render() {
    return OPTIONS.map(({ option, icon, label: name, shortcut }) => {
      const id = `acp-search-options-${option}`;
      const label = shortcuts.labelled(name, shortcut);
      return html`<md-icon-button
          id=${id}
          class="acp-search-options__option"
          ?selected=${this[option]}
          aria-label=${label}
          aria-keyshortcuts=${shortcuts.aria(shortcut)}
          aria-pressed=${this[option] ? 'true' : 'false'}
          @click=${() => this.#toggle(option)}
        >
          <md-icon class="acp-search-options__option-icon">${unsafeSVG(icon)}</md-icon>
        </md-icon-button>
        <md-tooltip for=${id} show-delay="800">${label}</md-tooltip>`;
    });
  }
}

customElements.define('acp-search-options', AcpSearchOptions);
