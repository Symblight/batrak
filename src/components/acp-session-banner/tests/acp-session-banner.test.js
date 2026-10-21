import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-session-banner.js';

describe('acp-session-banner', () => {
  it('offers Restart when agents.json changed what the running agent runs', async () => {
    const notice = { kind: /** @type {const} */ ('outdated'), message: 'agents.json changed what Fake runs. Restart to use it.' };
    const el = await fixture(html`<acp-session-banner .notice=${notice} .permission=${null}></acp-session-banner>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const banner = /** @type {HTMLElement & { label: string, dismissible: boolean }} */ (root.querySelector('chx-input-mode-banner'));
    expect(banner.label).to.equal(notice.message);
    expect(banner.dismissible).to.equal(true);
    const buttons = [...root.querySelectorAll('md-button')];
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Restart']);
    /** @type {unknown[]} */
    const acted = [];
    el.addEventListener('acp-session-action', (/** @type {Event} */ e) => acted.push(/** @type {CustomEvent} */ (e).detail.action));
    /** @type {HTMLElement} */ (buttons[0]).click();
    expect(acted).to.deep.equal(['restart']);
  });
});
