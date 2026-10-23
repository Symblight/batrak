import { expect, fixture, html } from '../../../../test/fixture.js';
import '../acp-session-sync.js';

/** @typedef {import('../acp-session-sync.js').AcpSessionSync} AcpSessionSync */
/** @typedef {import('../../../models/types.js').SessionSync} SessionSync */

/** @type {import('../../../models/types.js').SyncReport} */
const REPORT = {
  projectPath: '/p',
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  agents: [
    { agentId: 'claude', agentName: 'Claude Code', outcome: 'listed', count: 3, error: null },
    { agentId: 'codex', agentName: 'Codex', outcome: 'signIn', count: null, error: null },
  ],
};

/**
 * @param {SessionSync | null} sync
 * @returns {Promise<{ el: AcpSessionSync, root: ShadowRoot }>}
 */
async function render(sync) {
  const el = /** @type {AcpSessionSync} */ (await fixture(html`<acp-session-sync .sync=${sync}></acp-session-sync>`));
  return { el, root: /** @type {ShadowRoot} */ (el.shadowRoot) };
}

describe('acp-session-sync', () => {
  it('shows nothing without a project', async () => {
    const { root } = await render(null);
    expect(root.querySelector('md-icon-button')).to.equal(null);
  });

  it('spins while a sync runs', async () => {
    const { root } = await render({ running: true, report: null });
    const button = root.querySelector('md-icon-button');
    expect(button?.getAttribute('title')).to.equal('Syncing sessions…');
    expect(root.querySelector('.acp-session-sync__icon_running')).to.not.equal(null);
  });

  it("says how each agent did in its tooltip, with a warning dot when one needs the user", async () => {
    const { root } = await render({ running: false, report: REPORT });
    const button = root.querySelector('md-icon-button');
    expect(button?.getAttribute('title')).to.equal('Synced just now\nClaude Code · 3 sessions\nCodex · needs sign-in');
    expect(button?.getAttribute('aria-label')).to.equal('Resync sessions');
    expect(root.querySelector('.acp-session-sync__warning')).to.not.equal(null);
  });

  it('asks for a resync on click', async () => {
    const { el, root } = await render({ running: false, report: { ...REPORT, agents: [REPORT.agents[0]] } });
    expect(root.querySelector('.acp-session-sync__warning')).to.equal(null);
    /** @type {Event[]} */
    const asked = [];
    el.addEventListener('acp-session-resync', (e) => asked.push(e));
    /** @type {HTMLElement} */ (root.querySelector('md-icon-button')).click();
    expect(asked.map((e) => [e.bubbles, e.composed])).to.deep.equal([[true, true]]);
  });
});
