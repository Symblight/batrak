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

  it('offers Turn on instead of Restart when the user turned the agent off', async () => {
    const notice = { kind: /** @type {const} */ ('error'), message: 'Codex is off', offAgent: 'codex' };
    const el = await fixture(html`<acp-session-banner .notice=${notice} .permission=${null}></acp-session-banner>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const buttons = [...root.querySelectorAll('md-button')];
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Open log', 'Turn on']);
    /** @type {unknown[]} */
    const acted = [];
    el.addEventListener('acp-session-action', (/** @type {Event} */ e) => acted.push(/** @type {CustomEvent} */ (e).detail.action));
    /** @type {HTMLElement} */ (buttons[1]).click();
    expect(acted).to.deep.equal(['turn-on-agent']);
  });

  it('links a queued turn to the session it waits for', async () => {
    const notice = { kind: /** @type {const} */ ('queued'), message: 'Waiting for "Fix the tree" to finish', holder: { id: 'a', title: 'Fix the tree' } };
    const el = await fixture(html`<acp-session-banner .notice=${notice} .permission=${null}></acp-session-banner>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const banner = /** @type {HTMLElement & { label: string, dismissible: boolean }} */ (root.querySelector('chx-input-mode-banner'));
    expect(banner.label).to.equal(notice.message);
    expect(banner.dismissible).to.equal(false);
    /** @type {unknown[]} */
    const selected = [];
    el.addEventListener('acp-session-select', (/** @type {Event} */ e) => selected.push(/** @type {CustomEvent} */ (e).detail));
    const buttons = [...root.querySelectorAll('md-button')];
    expect(buttons.map((b) => b.textContent?.trim())).to.deep.equal(['Show session']);
    /** @type {HTMLElement} */ (buttons[0]).click();
    expect(selected).to.deep.equal([{ sessionId: 'a' }]);
  });
});
