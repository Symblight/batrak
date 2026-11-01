import { expect } from '@esm-bundle/chai';
import { LitElement, html } from 'lit';
import { DropTargetController } from '../DropTargetController.js';

class TestTarget extends LitElement {
  /** @type {string | null} */
  name = 'editor';
  /** @type {(id: string) => boolean} */
  accepts = () => true;
  drag = new DropTargetController(this, {
    name: () => this.name,
    area: () => this,
    accepts: (id) => this.accepts(id),
    over: () => {},
    leave: () => {},
    drop: () => {},
  });

  render() {
    return html`<slot></slot>`;
  }
}
customElements.define('test-drop-target', TestTarget);

describe('DropTargetController', () => {
  it('finds the target of a name under the pointer that takes the item, and only while it is connected and has room', async () => {
    // Arrange
    const target = /** @type {TestTarget} */ (document.createElement('test-drop-target'));
    target.style.cssText = 'display: block; width: 100px; height: 40px';
    document.body.append(target);
    await target.updateComplete;
    const rect = target.getBoundingClientRect();
    const inside = { x: rect.left + 10, y: rect.top + 10 };
    const found = () => DropTargetController.at('editor', 'tab', inside) === target.drag;

    // Assert
    expect(found(), 'under the pointer').to.equal(true);
    expect(DropTargetController.at('editor', 'tab', { x: rect.right + 5, y: rect.top + 10 }), 'outside it').to.equal(null);
    expect(DropTargetController.at('other', 'tab', inside), 'another name').to.equal(null);

    // Act + Assert
    target.accepts = () => false;
    expect(found(), 'an item it does not take').to.equal(false);
    target.accepts = () => true;
    target.style.display = 'none';
    expect(DropTargetController.at('editor', 'tab', { x: 0, y: 0 }), 'hidden: no box to be over').to.equal(null);
    target.style.display = 'block';
    target.remove();
    expect(found(), 'gone with its host').to.equal(false);
  });
});
