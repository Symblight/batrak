import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-nav-rail.js';

/** @typedef {import('../acp-nav-rail.js').AcpNavRail} AcpNavRail */

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
  it('renders all rail items including terminal', async () => {
    const el = await render(html`<acp-nav-rail></acp-nav-rail>`);
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const terminalButton = root.querySelector('#acp-nav-rail-terminal');
    expect(terminalButton).to.not.be.null;
    expect(terminalButton?.getAttribute('aria-label')).to.equal('Terminal');

    const filesButton = root.querySelector('#acp-nav-rail-files');
    const searchButton = root.querySelector('#acp-nav-rail-search');
    const changesButton = root.querySelector('#acp-nav-rail-changes');
    const notificationsButton = root.querySelector('#acp-nav-rail-notifications');
    const settingsButton = root.querySelector('#acp-nav-rail-settings');

    expect(filesButton).to.not.be.null;
    expect(searchButton).to.not.be.null;
    expect(changesButton).to.not.be.null;
    expect(notificationsButton).to.not.be.null;
    expect(settingsButton).to.not.be.null;
  });

  it('fires acp-open-terminal when terminal button is clicked', async () => {
    const el = await render(html`<acp-nav-rail></acp-nav-rail>`);
    const events = record(el, 'acp-open-terminal');
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    const terminalButton = /** @type {HTMLElement} */ (root.querySelector('#acp-nav-rail-terminal'));
    terminalButton.click();
    expect(events).to.have.length(1);
    expect(events[0].bubbles).to.equal(true);
    expect(events[0].composed).to.equal(true);
  });

  it('fires panel toggle events on top items', async () => {
    const el = await render(html`<acp-nav-rail></acp-nav-rail>`);
    const filesEvents = record(el, 'acp-show-files');
    const searchEvents = record(el, 'acp-find-in-files');
    const changesEvents = record(el, 'acp-show-changes');
    const settingsEvents = record(el, 'acp-show-settings');

    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {HTMLElement} */ (root.querySelector('#acp-nav-rail-files')).click();
    expect(filesEvents).to.have.length(1);

    /** @type {HTMLElement} */ (root.querySelector('#acp-nav-rail-search')).click();
    expect(searchEvents).to.have.length(1);

    /** @type {HTMLElement} */ (root.querySelector('#acp-nav-rail-changes')).click();
    expect(changesEvents).to.have.length(1);

    /** @type {HTMLElement} */ (root.querySelector('#acp-nav-rail-settings')).click();
    expect(settingsEvents).to.have.length(1);
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
