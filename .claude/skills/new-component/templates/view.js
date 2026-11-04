import { html } from 'lit';
import { StoreController } from '../../controllers/store/StoreController.js';
import { ViewElement } from '../../components/view-element/view-element.js';
// import { $something } from '../../stores/something/something.js';

/**
 * @tag acp-NAME
 * @summary TODO: one line.
 */
export class ClassName extends ViewElement {
  // #something = new StoreController(this, { store: $something });

  render() {
    return html``;
  }
}

customElements.define('acp-NAME', ClassName);
