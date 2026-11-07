import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../changes-menu.js';

/** @typedef {import('../changes-menu.js').AcpChangesMenu} AcpChangesMenu */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('acp-changes-menu', () => {
  it('opens from its button with Rollback, enabled once a file is picked, and Refresh, each asking for itself', async () => {
    // Arrange
    const el = /** @type {AcpChangesMenu} */ (await fixture(html`<acp-changes-menu></acp-changes-menu>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const button = /** @type {HTMLElement} */ (root.querySelector('md-icon-button'));
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (root.querySelector('md-menu'));
    const item = (/** @type {string} */ value) => /** @type {HTMLElementTagNameMap['md-menu-item']} */ (menu.querySelector(`md-menu-item[value="${value}"]`));
    /** @type {[string, unknown][]} */
    const fired = [];
    for (const type of ['acp-changes-rollback', 'acp-changes-refresh']) el.addEventListener(type, (e) => fired.push([type, /** @type {CustomEvent} */ (e).detail]));
    const pick = async (/** @type {string} */ value) => {
      button.click();
      await until(() => menu.open);
      await item(value).updateComplete;
      /** @type {HTMLElement} */ (item(value).shadowRoot?.querySelector('.md-menu-item__interactive')).click();
      await until(() => !menu.open);
    };
    // Act
    const disabledWithNoPicks = item('rollback').disabled;
    el.picked = 1;
    await el.updateComplete;
    const disabledWithAPick = item('rollback').disabled;
    await pick('rollback');
    await pick('refresh');
    // Assert
    expect(disabledWithNoPicks).to.equal(true);
    expect(disabledWithAPick).to.equal(false);
    expect(fired).to.deep.equal([['acp-changes-rollback', null], ['acp-changes-refresh', null]]);
    expect(tooltipOf(button)).to.equal('More actions');
  });

  it('read-only, offers Refresh but not Rollback', async () => {
    // Arrange
    const el = /** @type {AcpChangesMenu} */ (await fixture(html`<acp-changes-menu read-only .picked=${2}></acp-changes-menu>`));
    // Act
    const values = [.../** @type {ShadowRoot} */ (el.shadowRoot).querySelectorAll('md-menu-item')].map((item) => item.getAttribute('value'));
    // Assert
    expect(values).to.deep.equal(['refresh']);
  });
});
