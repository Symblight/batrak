import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../nav-rail.js';

/** @typedef {import('../nav-rail.js').AcpNavRail} AcpNavRail */

/**
 * @param {import('lit').TemplateResult} template
 * @returns {Promise<AcpNavRail>}
 */
async function render(template) {
  const el = /** @type {AcpNavRail} */ (await fixture(template));
  await el.updateComplete;
  return el;
}

/**
 * @param {AcpNavRail} el
 * @param {string} type
 * @returns {CustomEvent[]}
 */
function record(el, type) {
  /** @type {CustomEvent[]} */
  const events = [];
  el.addEventListener(type, (e) => events.push(/** @type {CustomEvent} */ (e)));
  return events;
}

describe('acp-nav-rail', () => {
  it('fires its event, bubbling and composed, when each button is clicked, and names each in a tooltip', async () => {
    const buttons = [
      ['files', 'acp-show-files', 'Files'],
      ['search', 'acp-find-in-files', 'Search'],
      ['changes', 'acp-show-changes', 'Changes'],
      ['terminal', 'acp-open-terminal', 'Terminal'],
      ['settings', 'acp-show-settings', 'Settings'],
    ];
    for (const [name, type, label] of buttons) {
      // Arrange
      const el = await render(html`<acp-nav-rail></acp-nav-rail>`);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const events = record(el, type);
      const button = /** @type {HTMLElement} */ (root.querySelector(`#acp-nav-rail-${name}`));
      // Act
      button.click();
      // Assert
      expect(events, name).to.have.length(1);
      expect([events[0].bubbles, events[0].composed], name).to.deep.equal([true, true]);
      expect(button.getAttribute('aria-label'), name).to.equal(label);
      expect(tooltipOf(button), name).to.contain(label);
      expect(root.querySelector('[title]')).to.equal(null);
    }
  });

  it('marks selected toggle button', async () => {
    const el = await render(html`<acp-nav-rail selected="files"></acp-nav-rail>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const filesButton = root.querySelector('#acp-nav-rail-files');
    const terminalButton = root.querySelector('#acp-nav-rail-terminal');

    expect(filesButton?.hasAttribute('selected')).to.equal(true);
    expect(terminalButton?.hasAttribute('selected')).to.equal(false);
  });

  it('shows badge when unread is true', async () => {
    const el = await render(html`<acp-nav-rail ?unread=${true}></acp-nav-rail>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const badge = root.querySelector('.acp-nav-rail__badge');
    expect(badge).to.not.be.null;
    const notificationsButton = root.querySelector('#acp-nav-rail-notifications');
    expect(notificationsButton?.getAttribute('aria-label')).to.equal('Notifications, unread');
  });
});
