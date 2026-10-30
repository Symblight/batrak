import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../acp-session-status.js';

/** @typedef {import('../acp-session-status.js').AcpSessionStatus} AcpSessionStatus */

describe('acp-session-status', () => {
  it('says what each status means, as a label and a tooltip', async () => {
    const el = /** @type {AcpSessionStatus} */ (await fixture(html`<acp-session-status></acp-session-status>`));
    const root = /** @type {ShadowRoot} */ (el.shadowRoot);
    /** @type {[import('../../../models/types.js').SessionIndicator, string, string][]} */
    const cases = [
      ['permission', 'Waiting for your permission', 'md-icon'],
      ['error', 'Last turn failed', 'md-icon'],
      ['running', 'Agent is working', 'md-progress-circular'],
      ['elsewhere', 'Active in another app', 'md-progress-circular'],
      ['terminal', 'In terminal', 'md-icon'],
      ['terminal-working', 'Working in terminal', 'md-progress-circular'],
      ['unread', 'New output', '.acp-session-status__dot'],
    ];
    for (const [indicator, label, part] of cases) {
      el.indicator = indicator;
      await el.updateComplete;
      const icon = root.querySelector('.acp-session-status__icon');
      expect([icon?.getAttribute('aria-label'), tooltipOf(icon)]).to.deep.equal([label, label]);
      expect(root.querySelector('[title]')).to.equal(null);
      expect(root.querySelector(part), indicator).to.not.equal(null);
    }
  });

  it('shows nothing for an idle session', async () => {
    const el = await fixture(html`<acp-session-status></acp-session-status>`);
    expect(el.shadowRoot.querySelector('.acp-session-status__icon')).to.equal(null);
  });
});
