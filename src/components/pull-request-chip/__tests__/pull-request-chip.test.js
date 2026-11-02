import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../pull-request-chip.js';

describe('acp-pull-request-chip', () => {
  it('offers the way in while GitHub is not usable, asks to sign in on click, and shows nothing otherwise', async () => {
    /** @type {[string, string | null][]} */
    const cases = [
      ['signedOut', 'Sign in to GitHub'],
      ['noCli', 'Install GitHub CLI'],
      ['ok', null],
      ['loading', null],
      ['hidden', null],
    ];
    for (const [status, label] of cases) {
      // Arrange
      const el = await fixture(html`<acp-pull-request-chip .status=${status}></acp-pull-request-chip>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const button = /** @type {HTMLElement | null} */ (root.querySelector('.acp-pull-request-chip__button'));
      /** @type {unknown[]} */
      const asked = [];
      el.addEventListener('acp-github-sign-in', () => asked.push(true));
      // Act
      button?.click();
      // Assert
      expect(button?.textContent?.trim() ?? null, status).to.equal(label);
      expect(asked.length, status).to.equal(label ? 1 : 0);
      if (button) expect(tooltipOf(button), status).to.be.a('string').and.not.equal('');
    }
  });
});
