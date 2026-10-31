import { LitElement, html } from 'lit';
import articleIcon from '@material-design-icons/svg/outlined/article.svg?raw';
import '../view-placeholder/view-placeholder.js';
import styles from './markdown-preview.css?inline';

/**
 * @tag acp-markdown-preview
 * @summary A Markdown file's tab (mock): the rendered preview is not built yet, so it shows the source.
 */
export class AcpMarkdownPreview extends LitElement {
  static properties = {
    path: {},
    content: {},
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} Absolute. */
    this.path = '';
    /** @type {string} The file's text. */
    this.content = '';
  }

  render() {
    return html`
      <acp-view-placeholder
        class="acp-markdown-preview__notice"
        .icon=${articleIcon}
        heading="Markdown preview"
        text="Rendering is not implemented yet; showing the source."
      ></acp-view-placeholder>
      <pre class="acp-markdown-preview__source">${this.content}</pre>
    `;
  }
}

customElements.define('acp-markdown-preview', AcpMarkdownPreview);
