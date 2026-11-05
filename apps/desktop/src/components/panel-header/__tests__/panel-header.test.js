import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../panel-header.js';

/** @typedef {import('../panel-header.js').AcpPanelHeader} AcpPanelHeader */

const ICON = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const SELECT = { id: 'select', icon: ICON, label: 'Select opened file' };
const REFRESH = { id: 'refresh', icon: ICON, label: 'Refresh files', tooltip: 'Refresh' };

describe('acp-panel-header', () => {
  it('shows its heading, with no action button unless it has one', async () => {
    const el = /** @type {AcpPanelHeader} */ (await fixture(html`<acp-panel-header heading="Files"></acp-panel-header>`));
    expect(el.shadowRoot?.querySelector('.acp-panel-header__title')?.textContent).to.equal('Files');
    expect(el.shadowRoot?.querySelector('md-icon-button')).to.equal(null);
  });

  it('names each action by a label and a tooltip, never a title', async () => {
    // Act
    const el = /** @type {AcpPanelHeader} */ (await fixture(html`<acp-panel-header heading="Files" .actions=${[SELECT, REFRESH]}></acp-panel-header>`));
    // Assert
    const buttons = [...(el.shadowRoot?.querySelectorAll('md-icon-button') ?? [])];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).to.deep.equal(['Select opened file', 'Refresh files']);
    expect(buttons.map((b) => tooltipOf(b))).to.deep.equal(['Select opened file', 'Refresh']);
    expect(buttons.every((b) => b.querySelector('svg'))).to.equal(true);
    expect(el.shadowRoot?.querySelector('[title]')).to.equal(null);
  });

  it('fires acp-panel-header-action with the id of the clicked action; a disabled one is disabled alone', async () => {
    // Arrange
    const el = /** @type {AcpPanelHeader} */ (
      await fixture(html`<acp-panel-header heading="Files" .actions=${[{ ...SELECT, disabled: true }, REFRESH]}></acp-panel-header>`)
    );
    /** @type {unknown[]} */
    const fired = [];
    el.addEventListener('acp-panel-header-action', (e) => fired.push(/** @type {CustomEvent} */ (e).detail));
    const [select, refresh] = /** @type {HTMLElement[]} */ ([...(el.shadowRoot?.querySelectorAll('md-icon-button') ?? [])]);
    // Act
    refresh.click();
    // Assert
    expect(fired).to.deep.equal([{ id: 'refresh' }]);
    expect([select.hasAttribute('disabled'), refresh.hasAttribute('disabled')]).to.deep.equal([true, false]);
  });
});
