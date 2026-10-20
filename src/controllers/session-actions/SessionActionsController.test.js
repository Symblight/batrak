import { LitElement } from 'lit';
import { expect, fixture, html } from '../../../test/fixture.js';
import { SessionActionsController } from './SessionActionsController.js';

class ActionsHost extends LitElement {
  actions = new SessionActionsController(this, { confirm: () => null });

  render() {
    return html`<span></span>`;
  }
}
customElements.define('test-session-actions-host', ActionsHost);

describe('SessionActionsController', () => {
  it('takes the session events its host’s children fire, so they go no further', async () => {
    const host = /** @type {ActionsHost} */ (await fixture(html`<test-session-actions-host></test-session-actions-host>`));
    const child = /** @type {Element} */ (host.shadowRoot?.querySelector('span'));
    /** @type {string[]} */
    const escaped = [];
    const types = ['acp-session-rename', 'acp-session-reveal', 'acp-session-delete'];
    for (const type of types) document.body.addEventListener(type, () => escaped.push(type), { once: true });
    for (const type of types) {
      child.dispatchEvent(new CustomEvent(type, { detail: { sessionId: 'unknown' }, bubbles: true, composed: true }));
    }
    expect(escaped).to.deep.equal([]);
  });
});
