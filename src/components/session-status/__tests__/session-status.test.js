import { expect, fixture, html, tooltipOf } from '../../../../test/fixture.js';
import '../session-status.js';

/** @typedef {import('../session-status.js').AcpSessionStatus} AcpSessionStatus */
/** @typedef {import('../../../models/types/types.js').Session} Session */

const NOW = Date.parse('2026-10-23T13:00:00.000Z');
const SOON = '2026-10-23T13:01:00.000Z';

/** @param {Partial<Session>} extra */
const session = (extra) => /** @type {Session} */ ({ id: 's', status: 'stopped', inTerminal: false, ...extra });

/**
 * @param {Partial<AcpSessionStatus>} props
 * @returns {Promise<AcpSessionStatus>}
 */
async function render(props) {
  const el = /** @type {AcpSessionStatus} */ (await fixture(html`<acp-session-status></acp-session-status>`));
  Object.assign(el, { now: NOW, ...props });
  await el.updateComplete;
  return el;
}

describe('acp-session-status', () => {
  it('works out what a session says, and shows it as a label and a tooltip', async () => {
    /** @type {[Partial<AcpSessionStatus>, string, string, string][]} */
    const cases = [
      [{ session: session({ status: 'stopped' }), permissionPending: true }, 'permission', 'Waiting for your permission', 'md-icon'],
      [{ session: session({ status: 'error' }) }, 'error', 'Last turn failed', 'md-icon'],
      [{ session: session({ status: 'working' }) }, 'running', 'Agent is working', 'md-progress-circular'],
      [{ session: session({ status: 'queued' }) }, 'queued', 'Waiting for the project', 'md-icon'],
      [{ session: session({ activeElsewhereUntil: SOON }) }, 'elsewhere', 'Active in another app', 'md-progress-circular'],
      [{ session: session({ inTerminal: true }) }, 'terminal', 'In terminal', 'md-icon'],
      [{ session: session({ inTerminal: true, activeElsewhereUntil: SOON }) }, 'terminal-working', 'Working in terminal', 'md-progress-circular'],
      [{ session: session({}), unread: true }, 'unread', 'New output', '.acp-session-status__dot'],
    ];
    for (const [props, indicator, label, part] of cases) {
      const el = await render(props);
      const root = /** @type {ShadowRoot} */ (el.shadowRoot);
      const icon = root.querySelector('.acp-session-status__icon');
      expect(el.indicator).to.equal(indicator);
      expect(el.getAttribute('indicator'), 'the host says it too').to.equal(indicator);
      expect([icon?.getAttribute('aria-label'), tooltipOf(icon)], indicator).to.deep.equal([label, label]);
      expect(root.querySelector('[title]')).to.equal(null);
      expect(root.querySelector(part), indicator).to.not.equal(null);
    }
  });

  it('shows nothing for an idle session, for no session, and for a terminal session it is told to keep quiet about', async () => {
    for (const props of [{ session: session({}) }, { session: null }, { session: session({ inTerminal: true }), quiet: true }]) {
      const el = await render(props);
      expect(el.indicator).to.equal(null);
      expect(el.hasAttribute('indicator')).to.equal(false);
      expect(el.shadowRoot?.querySelector('.acp-session-status__icon')).to.equal(null);
    }
    const working = await render({ session: session({ inTerminal: true, activeElsewhereUntil: SOON }), quiet: true });
    expect(working.indicator, 'quiet only drops the idle terminal').to.equal('terminal-working');
  });
});
