import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../panel-header.js';

/** @typedef {import('../panel-header.js').AcpPanelHeader} AcpPanelHeader */

const ACTION = { icon: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', label: 'Refresh' };

describe('acp-panel-header', () => {
  it('shows its heading, with no action button unless it has one', async () => {
    const el = /** @type {AcpPanelHeader} */ (await fixture(html`<acp-panel-header heading="Files"></acp-panel-header>`));
    expect(el.shadowRoot?.querySelector('.acp-panel-header__title')?.textContent).to.equal('Files');
    expect(el.shadowRoot?.querySelector('md-icon-button')).to.equal(null);
  });

  it('names its action by a label and a tooltip, never a title', async () => {
    const el = /** @type {AcpPanelHeader} */ (await fixture(html`<acp-panel-header heading="Files" .action=${ACTION}></acp-panel-header>`));
    const button = el.shadowRoot?.querySelector('md-icon-button');
    expect(button?.getAttribute('aria-label')).to.equal('Refresh');
    expect(tooltipOf(button)).to.equal('Refresh');
    el.action = { ...ACTION, label: 'Refresh files', tooltip: 'Refresh' };
    await el.updateComplete;
    expect(button?.getAttribute('aria-label')).to.equal('Refresh files');
    expect(tooltipOf(button)).to.equal('Refresh');
    expect(el.shadowRoot?.querySelector('[title]')).to.equal(null);
    expect(button?.querySelector('svg')).to.not.equal(null);
  });

  it('fires acp-panel-header-action on a click, unless the action is disabled', async () => {
    const el = /** @type {AcpPanelHeader} */ (await fixture(html`<acp-panel-header heading="Files" .action=${ACTION}></acp-panel-header>`));
    let fired = 0;
    el.addEventListener('acp-panel-header-action', () => fired++);
    const button = /** @type {HTMLElement} */ (el.shadowRoot?.querySelector('md-icon-button'));
    button.click();
    expect(fired).to.equal(1);
    el.actionDisabled = true;
    await el.updateComplete;
    expect(button.hasAttribute('disabled')).to.equal(true);
  });
});
