import { expect, fixture, html } from '../../../../test/fixture.js';
import '../about-dialog.js';

/** @typedef {import('../about-dialog.js').AcpAboutDialog} AcpAboutDialog */

const ABOUT = { version: '0.9.2', os: 'macOS 26.1', arch: 'aarch64', logDir: '/logs', updatesEnabled: true };

/**
 * @param {import('../../../hooks/settings/types.js').AboutInfo} about
 * @param {import('../../../hooks/app-update/types.js').UpdateCheck} updateCheck
 */
async function render(about, updateCheck = { checking: false, message: null }) {
  const el = /** @type {AcpAboutDialog} */ (await fixture(html`<acp-about-dialog .about=${about} .updateCheck=${updateCheck}></acp-about-dialog>`));
  const root = /** @type {ShadowRoot} */ (el.shadowRoot);
  return { el, root, button: /** @type {HTMLElementTagNameMap['md-button'] | null} */ (root.querySelector('.acp-about-dialog__check')) };
}

describe('acp-about-dialog', () => {
  it('offers Check for updates only in a build that updates, and asks by an event', async () => {
    // Act
    const debug = await render({ ...ABOUT, updatesEnabled: false });

    // Assert
    expect(debug.button === null, 'none in a debug build').to.equal(true);

    // Arrange
    const { el, button } = await render(ABOUT);
    let asked = 0;
    el.addEventListener('acp-update-check', () => asked++);

    // Act
    button?.click();

    // Assert
    expect(button?.textContent?.trim()).to.equal('Check for updates');
    expect(asked).to.equal(1);
  });

  it("says what the check found, and can't be asked again while it runs", async () => {
    /** @type {[import('../../../hooks/app-update/types.js').UpdateCheck, boolean][]} */
    const cases = [
      [{ checking: true, message: 'Checking…' }, true],
      [{ checking: false, message: 'Batrak 0.9.2 is up to date' }, false],
      [{ checking: false, message: "Couldn't reach GitHub" }, false],
    ];
    for (const [check, disabled] of cases) {
      // Act
      const { root, button } = await render(ABOUT, check);

      // Assert
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).to.equal(check.message);
      expect(button?.hasAttribute('disabled'), `${check.message}: disabled`).to.equal(disabled);
    }
  });
});
