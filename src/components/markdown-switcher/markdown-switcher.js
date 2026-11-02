import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import codeIcon from '@material-design-icons/svg/outlined/code.svg?raw';
import splitIcon from '@material-design-icons/svg/outlined/vertical_split.svg?raw';
import previewIcon from '@material-design-icons/svg/outlined/visibility.svg?raw';
import linkIcon from '@material-design-icons/svg/outlined/link.svg?raw';
import linkOffIcon from '@material-design-icons/svg/outlined/link_off.svg?raw';
import { shortcuts } from '../../hooks/shortcuts/shortcuts.js';
import styles from './markdown-switcher.css?inline';

/** @typedef {import('../../hooks/markdown/types.js').MarkdownMode} MarkdownMode */

/**
 * @tag acp-markdown-switcher
 * @summary The segmented control that floats over a markdown file: Raw, Split and Preview, and in Split a toggle for scrolling the two panes together.
 * @fires acp-markdown-mode `{ mode }` A view other than the shown one was pressed.
 * @fires acp-markdown-sync `{ on }` The scroll sync toggle was pressed.
 */
export class AcpMarkdownSwitcher extends LitElement {
  static properties = {
    mode: { type: String, reflect: true },
    scrollSync: { attribute: false },
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {MarkdownMode} */
    this.mode = 'raw';
    /** @type {boolean} In Split, the panes scroll together. */
    this.scrollSync = true;
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** @returns {{ mode: MarkdownMode, label: string, hint: string, icon: string }[]} */
  #views() {
    return [
      { mode: 'raw', label: 'Raw', hint: 'Raw', icon: codeIcon },
      { mode: 'split', label: 'Split', hint: `Split (${shortcuts.hint('markdownSplit')})`, icon: splitIcon },
      { mode: 'preview', label: 'Preview', hint: `Preview (${shortcuts.hint('markdownPreview')})`, icon: previewIcon },
    ];
  }

  render() {
    const sync = this.scrollSync;
    return html`
      <div class="acp-markdown-switcher__group" role="group" aria-label="Markdown view">
        ${repeat(
          this.#views(),
          (v) => v.mode,
          (v) => html`
            <button
              type="button"
              id="acp-markdown-switcher-${v.mode}"
              class="acp-markdown-switcher__segment"
              aria-label=${v.label}
              aria-pressed=${this.mode === v.mode ? 'true' : 'false'}
              @click=${() => v.mode !== this.mode && this.#emit('acp-markdown-mode', { mode: v.mode })}
            >
              <md-icon class="acp-markdown-switcher__icon">${unsafeSVG(v.icon)}</md-icon>
            </button>
            <md-tooltip for="acp-markdown-switcher-${v.mode}" show-delay="800" placement="bottom">${v.hint}</md-tooltip>
          `,
        )}
        ${this.mode === 'split'
          ? html`
              <span class="acp-markdown-switcher__separator" role="separator"></span>
              <button
                type="button"
                id="acp-markdown-switcher-sync"
                class="acp-markdown-switcher__segment acp-markdown-switcher__sync"
                aria-label="Scroll together"
                aria-pressed=${sync ? 'true' : 'false'}
                @click=${() => this.#emit('acp-markdown-sync', { on: !sync })}
              >
                <md-icon class="acp-markdown-switcher__icon">${unsafeSVG(sync ? linkIcon : linkOffIcon)}</md-icon>
              </button>
              <md-tooltip for="acp-markdown-switcher-sync" show-delay="800" placement="bottom">Scroll together</md-tooltip>
            `
          : nothing}
      </div>
    `;
  }
}

customElements.define('acp-markdown-switcher', AcpMarkdownSwitcher);
