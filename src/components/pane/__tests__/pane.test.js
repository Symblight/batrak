import { expect, fixture, html } from '../../../../test/fixture.js';
import '../pane.js';

describe('acp-pane', () => {
  it('holds its content in a default slot and takes no edge unless given one', async () => {
    const el = await fixture(html`<acp-pane><span id="inner"></span></acp-pane>`);
    const slot = /** @type {HTMLSlotElement} */ (el.shadowRoot?.querySelector('slot'));
    expect(slot.assignedElements().map((e) => e.id)).to.deep.equal(['inner']);
    expect(el.edge).to.equal(null);
    expect((await fixture(html`<acp-pane edge="end"></acp-pane>`)).edge).to.equal('end');
  });
});
