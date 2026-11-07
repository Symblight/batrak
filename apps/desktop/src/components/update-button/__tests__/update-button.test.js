import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../update-button.js';

/** @typedef {import('../update-button.js').AcpUpdateButton} AcpUpdateButton */
/** @typedef {import('../../../hooks/app-update/types.js').AppUpdateState} AppUpdateState */

const MB = 1024 * 1024;

/** @type {Record<string, AppUpdateState>} */
const STATES = {
  available: { state: 'available', version: '0.9.3', current: '0.9.2', manual: false },
  manual: { state: 'available', version: '0.9.3', current: '0.9.2', manual: true },
  downloading: { state: 'downloading', version: '0.9.3', received: 16 * MB, total: 38 * MB },
  ready: { state: 'ready', version: '0.9.3', onNextLaunch: false },
  nextLaunch: { state: 'ready', version: '0.9.3', onNextLaunch: true },
  failed: { state: 'failed', version: '0.9.3', reason: "couldn't reach GitHub" },
};

/** @param {AppUpdateState} state */
async function render(state) {
  const el = /** @type {AcpUpdateButton} */ (await fixture(html`<acp-update-button .state=${state}></acp-update-button>`));
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

/** @param {string | null | undefined} text */
const squeezed = (text) => text?.replace(/\s+/g, ' ').trim();

/** @param {ShadowRoot} root */
const button = (root) => /** @type {HTMLElement} */ (root.querySelector('md-button'));

describe('acp-update-button', () => {
  it('each state shows its label, name and menu, and nothing the spec removed', async () => {
    const cases = [
      { state: STATES.available, label: 'Update 0.9.3', title: 'Batrak 0.9.3 available', detail: '0.9.2 → 0.9.3', items: ['Update and Restart'] },
      { state: STATES.manual, label: 'Update 0.9.3', title: 'Batrak 0.9.3 available', detail: '0.9.2 → 0.9.3', items: ['Download manually'] },
      { state: STATES.downloading, label: 'Updating… 42%', title: 'Downloading 0.9.3…', detail: '16 of 38 MB', items: ['Cancel download 42%'] },
      { state: STATES.ready, label: 'Restart to update', title: 'Batrak 0.9.3 is ready', detail: 'restart to finish the update', items: ['Restart to update', 'Update on next launch'] },
      { state: STATES.failed, label: 'Update failed', title: "Update failed: couldn't reach GitHub", detail: '', items: ['Retry', 'Download manually'] },
    ];
    for (const { state, label, title, detail, items } of cases) {
      // Act
      const { root } = await render(state);

      // Assert
      const why = `${state.state}: ${label}`;
      expect(squeezed(button(root).textContent), why).to.equal(label);
      expect(button(root).getAttribute('aria-label'), `${why}: name`).to.equal(label);
      expect(squeezed(root.querySelector('.acp-update-button__title')?.textContent), `${why}: title`).to.equal(title);
      expect(squeezed(root.querySelector('.acp-update-button__detail')?.textContent) ?? '', `${why}: detail`).to.equal(detail);
      expect([...root.querySelectorAll('md-menu-item')].map((i) => squeezed(i.textContent)), `${why}: items`).to.deep.equal(items);
      expect(root.querySelector('[title]'), `${why}: no title attribute`).to.equal(null);
    }
  });

  it('shows nothing without an update, and while installing only a status, with no menu', async () => {
    for (const state of /** @type {AppUpdateState[]} */ ([{ state: 'none' }, { state: 'updated', version: '0.9.3' }])) {
      // Act
      const { root } = await render(state);

      // Assert
      expect(root.querySelector('md-button, md-menu, [role="status"]'), state.state).to.equal(null);
    }

    // Act
    const { root } = await render({ state: 'installing', version: '0.9.3' });

    // Assert
    expect(squeezed(root.querySelector('[role="status"]')?.textContent)).to.equal('Installing…');
    expect(root.querySelector('md-button, md-menu'), 'nothing to click').to.equal(null);
  });

  it('each menu item fires its intent, across shadow roots', async () => {
    /** @type {[AppUpdateState, string, string, unknown][]} */
    const cases = [
      [STATES.available, 'download', 'acp-update-download', null],
      [STATES.manual, 'manual', 'acp-update-manual', null],
      [STATES.downloading, 'cancel', 'acp-update-cancel', null],
      [STATES.ready, 'restart', 'acp-update-restart', null],
      [STATES.ready, 'on-next-launch', 'acp-update-on-next-launch', { on: true }],
      [STATES.nextLaunch, 'on-next-launch', 'acp-update-on-next-launch', { on: false }],
      [STATES.failed, 'retry', 'acp-update-download', null],
      [STATES.failed, 'manual', 'acp-update-manual', null],
    ];
    for (const [state, value, type, detail] of cases) {
      // Arrange
      const { el, root } = await render(state);
      /** @type {CustomEvent[]} */
      const fired = [];
      el.addEventListener(type, (e) => fired.push(/** @type {CustomEvent} */ (e)));
      const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));

      // Act
      menu.dispatchEvent(new CustomEvent('select', { detail: { value } }));

      // Assert
      const why = `${state.state} ${value}`;
      expect(fired.map((e) => e.detail), why).to.deep.equal([detail]);
      expect(fired[0].composed, `${why}: composed`).to.equal(true);
    }
  });

  it('marks Update on next launch as chosen, only when it is', async () => {
    for (const [state, selected] of /** @type {[AppUpdateState, boolean][]} */ ([[STATES.ready, false], [STATES.nextLaunch, true]])) {
      // Act
      const { root } = await render(state);

      // Assert
      expect(root.querySelector('md-menu-item[value="on-next-launch"]')?.hasAttribute('selected')).to.equal(selected);
    }
  });

  it('tells assistive tech and the pointer what the button is: its tooltip, that it opens a menu, whether it is open', async () => {
    // Arrange
    const { root } = await render(STATES.available);
    const menu = /** @type {HTMLElement} */ (root.querySelector('md-menu'));
    expect(tooltipOf(button(root)), 'tooltip').to.equal('Batrak 0.9.3 available · click for options');
    expect(button(root).getAttribute('aria-haspopup')).to.equal('menu');
    expect(button(root).getAttribute('aria-expanded'), 'closed').to.equal('false');
    const host = /** @type {AcpUpdateButton} */ (/** @type {ShadowRoot} */ (root).host);

    // Act
    menu.dispatchEvent(new Event('opening'));
    await host.updateComplete;

    // Assert
    expect(button(root).getAttribute('aria-expanded'), 'open').to.equal('true');
  });

  it('shows how far a download is on the ring and the bar, and neither claims a number with no total', async () => {
    /** @type {[AppUpdateState, number | undefined, string, string][]} */
    const cases = [
      [STATES.downloading, 0.42, '16 of 38 MB', 'Updating… 42%'],
      [{ state: 'downloading', version: '0.9.3', received: 5 * MB, total: null }, undefined, '5 MB', 'Updating…'],
    ];
    for (const [state, value, detail, name] of cases) {
      // Act
      const { root } = await render(state);

      // Assert
      const bar = /** @type {HTMLElementTagNameMap['md-progress-linear']} */ (root.querySelector('md-progress-linear'));
      const ring = root.querySelector('md-progress-circular');
      expect(bar.value, 'bar').to.equal(value);
      expect(ring?.value, 'ring').to.equal(value);
      expect(bar.getAttribute('aria-label'), 'named').to.equal('Download progress');
      expect(squeezed(root.querySelector('.acp-update-button__detail')?.textContent)).to.equal(detail);
      expect(button(root).getAttribute('aria-label')).to.equal(name);
    }
  });
});
