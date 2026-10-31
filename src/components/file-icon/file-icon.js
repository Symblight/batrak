import { LitElement, html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/wc-material/icon';
import genericIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import folderIcon from '@material-design-icons/svg/outlined/folder.svg?raw';
import { fileIcons, byExtension, byName } from './icons.js';

/** @param {string} name */
function logoKey(name) {
  const lower = name.toLowerCase();
  return byName[lower] ?? byExtension[lower.slice(lower.lastIndexOf('.') + 1)];
}

/**
 * The icon for a file or folder name, as SVG markup, for rows that take a string
 * (`@symblight/chat` chips, `@symblight/tree-view` rows).
 */
export const fileIcon = Object.freeze({
  /**
   * @param {string} name
   * @param {boolean} [folder]
   */
  svgFor(name, folder = false) {
    if (folder) return folderIcon;
    const key = logoKey(name);
    return key ? fileIcons[key] : genericIcon;
  },

  /**
   * Whether the name has a language logo of its own (not the generic file icon).
   * @param {string} name
   */
  has(name) {
    return logoKey(name) !== undefined;
  },
});

/**
 * @tag acp-file-icon
 * @summary The icon of a file (its language's logo, else a generic one) or of a folder. Light DOM, sized by `font-size`.
 */
export class AcpFileIcon extends LitElement {
  static properties = {
    name: { type: String },
    folder: { type: Boolean },
  };

  constructor() {
    super();
    this.name = '';
    this.folder = false;
  }

  /** Light DOM: an inline-flex box in its parent's tree, sized by the parent's `font-size`. */
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    this.style.display = 'inline-flex';
    super.connectedCallback();
  }

  render() {
    return html`<md-icon>${unsafeSVG(fileIcon.svgFor(this.name, this.folder))}</md-icon>`;
  }
}

customElements.define('acp-file-icon', AcpFileIcon);
