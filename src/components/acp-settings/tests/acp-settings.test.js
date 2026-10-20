import { expect, fixture, html } from '../../../../test/fixture.js';
import { DEFAULT_SETTINGS } from '../../../models/settings.js';
import '../acp-settings.js';

describe('acp-settings', () => {
  it('names the bundled font the editor uses by default', async () => {
    const el = await fixture(html`<acp-settings .settings=${DEFAULT_SETTINGS} .fonts=${[]}></acp-settings>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const option = /** @type {HTMLElement} */ (root.querySelector('.acp-settings__input_font md-option[value=""]'));
    expect(option.textContent?.trim()).to.equal('Google Sans Code (default)');
  });
});
