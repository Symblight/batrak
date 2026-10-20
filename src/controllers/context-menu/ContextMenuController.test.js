import { LitElement } from 'lit';
import { expect, fixture, html } from '../../../test/fixture.js';
import '@symblight/wc-material/menu';
import { ContextMenuController } from './ContextMenuController.js';

describe('ContextMenuController.showOnly', () => {
  it('closes the menu shown before, app-wide', async () => {
    const first = document.createElement('md-menu');
    const second = document.createElement('md-menu');
    document.body.append(first, second);
    ContextMenuController.showOnly(first);
    first.openAtPoint(0, 0);
    ContextMenuController.showOnly(second);
    expect(first.open).to.equal(false);
    first.remove();
    second.remove();
  });
});

class MenuHost extends LitElement {
  /** @type {ContextMenuController<string>} */
  controller = new ContextMenuController(this, {
    menu: () => this.renderRoot.querySelector('md-menu'),
    onSelect: () => {},
  });

  render() {
    return html`<button>⋮</button><md-menu></md-menu>`;
  }
}
customElements.define('test-menu-host', MenuHost);

describe('ContextMenuController.openFrom', () => {
  it('opens under an element for a target, and closes when asked again from it', async () => {
    const host = /** @type {MenuHost} */ (await fixture(html`<test-menu-host></test-menu-host>`));
    const root = /** @type {ShadowRoot} */ (host.shadowRoot);
    const button = /** @type {HTMLElement} */ (root.querySelector('button'));
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('md-menu'));
    await host.controller.openFrom('a', button);
    expect([menu.open, menu.anchorElement, host.controller.target]).to.deep.equal([true, button, 'a']);
    await host.controller.openFrom('a', button);
    expect(menu.open).to.equal(false);
  });
});
