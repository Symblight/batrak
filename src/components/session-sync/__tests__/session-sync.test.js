import { expect, fixture, html } from '../../../../test/fixture.js';
import '../session-sync.js';

/** @typedef {import('../session-sync.js').AcpSessionSync} AcpSessionSync */
/** @typedef {import('../../../hooks/sessions/types.js').SessionSync} SessionSync */

/** @type {import('../../../hooks/sessions/types.js').SyncReport} */
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

/**
 * The tooltip's lines, and whether it belongs to the button.
 * @param {ShadowRoot} root
 */
function tooltip(root) {
  const tip = root.querySelector('md-tooltip');
  const lines = [...(tip?.querySelectorAll('.acp-session-sync__line') ?? [])].map((l) => l.textContent?.trim());
  return { lines, anchored: tip?.getAttribute('for') === root.querySelector('md-icon-button')?.id };
}

describe('acp-session-sync', () => {
  it('shows nothing without a project', async () => {
    const { root } = await render(null);
    expect(root.querySelector('md-icon-button')).to.equal(null);
  });

  it('shows a spinner in place of the icon while a sync runs', async () => {
    const { root } = await render({ running: true, report: null });
    expect(tooltip(root)).to.deep.equal({ lines: ['Syncing sessions…'], anchored: true });
    expect(root.querySelector('md-icon-button')?.hasAttribute('title'), 'no native tooltip').to.equal(false);
    expect(root.querySelector('md-progress-circular')).to.not.equal(null);
    expect(root.querySelector('md-icon'), 'no rotating icon').to.equal(null);
  });

  it("adds how each agent did to its short md-tooltip, with a warning dot, when one needs the user", async () => {
    const { root } = await render({ running: false, report: REPORT });
    expect(tooltip(root).lines).to.deep.equal(['Refresh sessions', 'Claude Code · 3 sessions', 'Codex · needs sign-in']);
    expect(root.querySelector('md-icon-button')?.getAttribute('aria-label')).to.equal('Refresh sessions');
    expect(root.querySelector('.acp-session-sync__warning')).to.not.equal(null);
    expect(root.querySelector('md-progress-circular'), 'no spinner when idle').to.equal(null);
    expect(root.querySelector('md-icon')).to.not.equal(null);
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
