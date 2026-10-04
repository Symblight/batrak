import { LitElement, html } from 'lit';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $workspace } from '../../stores/workspace.js';
import styles from './acp-toolbar.css?inline';

/**
 * @tag acp-toolbar
 * @summary Narrow app-wide bar above the columns showing the opened folder's name.
 */
export class AcpToolbar extends LitElement {
  static styles = styles;

  #workspace = new StoreController(this, { store: $workspace });

  render() {
    const workspace = this.#workspace.value;
    return html`<span class="acp-toolbar__name" title=${workspace?.path ?? ''}>${workspace?.name ?? ''}</span>`;
  }
}

customElements.define('acp-toolbar', AcpToolbar);
