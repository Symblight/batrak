import { LitElement, html } from 'lit';
import imageIcon from '@material-design-icons/svg/outlined/image.svg?raw';
import '../acp-view-placeholder/acp-view-placeholder.js';
import styles from './acp-image-preview.css?inline';

/**
 * @tag acp-image-preview
 * @summary An image file's tab, SVG included (mock): shows which file, not the image yet.
 */
export class AcpImagePreview extends LitElement {
  static properties = {
    path: {},
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} Absolute. */
    this.path = '';
  }

  render() {
    return html`<acp-view-placeholder
      class="acp-image-preview__placeholder"
      .icon=${imageIcon}
      heading="Image preview"
      text=${`Not implemented yet: ${this.path}`}
    ></acp-view-placeholder>`;
  }
}

customElements.define('acp-image-preview', AcpImagePreview);
