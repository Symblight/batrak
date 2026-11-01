import { expect, fixture, html } from '../../../../test/fixture.js';
import '../split.js';

describe('acp-split', () => {
  it('holds its panes and handles in one default slot, in order', async () => {
    const el = await fixture(html`<acp-split><i id="a"></i><b id="h"></b><i id="b"></i></acp-split>`);
    const slot = /** @type {HTMLSlotElement} */ (el.shadowRoot?.querySelector('slot'));
    expect(slot.assignedElements().map((e) => e.id)).to.deep.equal(['a', 'h', 'b']);
  });
});
