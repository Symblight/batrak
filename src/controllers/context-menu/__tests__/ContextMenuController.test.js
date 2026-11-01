import { LitElement } from 'lit';
import { expect, fixture, html } from '../../../../test/fixture.js';
import '@symblight/wc-material/menu';
import { ContextMenuController } from '../ContextMenuController.js';

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

describe('ContextMenuController.onKeydown', () => {
  it('opens the menu under the focused target on ContextMenu or Shift+F10, and leaves other keys to the host', async () => {
    // Arrange
    const host = /** @type {MenuHost} */ (await fixture(html`<test-menu-host></test-menu-host>`));
    const root = /** @type {ShadowRoot} */ (host.shadowRoot);
    const button = /** @type {HTMLElement} */ (root.querySelector('button'));
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('md-menu'));
    /** @type {boolean[]} */
    const handled = [];
    button.addEventListener('keydown', (e) => handled.push(host.controller.onKeydown('a', e)));
    /** @type {[string, KeyboardEventInit, boolean][]} */
    const cases = [
      ['a', {}, false],
      ['F10', {}, false],
      ['ContextMenu', {}, true],
      ['F10', { shiftKey: true }, true],
    ];
    for (const [key, init, opens] of cases) {
      // Act
      const event = new KeyboardEvent('keydown', { key, ...init, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 20));
      // Assert
      expect([handled.at(-1), event.defaultPrevented, menu.open], `${key} ${JSON.stringify(init)}`).to.deep.equal([opens, opens, opens]);
      expect(host.controller.target, 'the menu is for the target').to.equal(opens ? 'a' : null);
      await menu.close();
    }
  });
});
