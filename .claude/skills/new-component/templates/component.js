import { LitElement, html } from 'lit';
import styles from './NAME.css?inline';

/**
 * @tag acp-NAME
 * @summary TODO: one line.
 * @fires acp-NAME-change `{ value: string }` TODO: delete if it fires nothing.
 */
export class ClassName extends LitElement {
  static properties = {
    value: {},
  };

  static styles = styles;

  constructor() {
    super();
    /** @type {string} */
    this.value = '';
  }

  render() {
    return html`<span class="acp-NAME__label">${this.value}</span>`;
  }
}

customElements.define('acp-NAME', ClassName);
