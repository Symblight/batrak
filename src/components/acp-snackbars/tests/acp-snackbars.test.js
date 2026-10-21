import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-snackbars.js';

/** @typedef {import('../../../models/types.js').Notice} Notice */

describe('acp-snackbars', () => {
  it('offers a notice’s action and reports the click', async () => {
    /** @type {Notice[]} */
    const notices = [
      { id: 1, level: 'info', message: 'Gemini CLI removed', count: 1, action: { label: 'Undo', run: () => {} } },
      { id: 2, level: 'warn', message: 'plain', count: 1 },
    ];
    const el = await fixture(html`<acp-snackbars .notices=${notices}></acp-snackbars>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const actions = [...root.querySelectorAll('.acp-snackbars__action')];
    expect(actions.map((a) => a.textContent?.trim())).to.deep.equal(['Undo']);
    /** @type {unknown[]} */
    const run = [];
    el.addEventListener('acp-notice-action', (/** @type {Event} */ e) => run.push(/** @type {CustomEvent} */ (e).detail));
    /** @type {HTMLElement} */ (actions[0]).click();
    expect(run).to.deep.equal([{ id: 1 }]);
  });
});
