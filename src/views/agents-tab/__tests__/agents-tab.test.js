import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $agentList, $agentsPending, $agentsQuery, $agentsView, $signIns } from '../../../stores/agents/agents.js';
import { $agentViews } from '../../../stores/session-views/session-views.js';
import { $agentsReveal, AGENTS_TAB_ID, activateTab, closeAllTabs, openAgents, openSettings } from '../../../stores/editor/editor.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import '../agents-tab.js';

/** @typedef {import('../agents-tab.js').AcpAgentsTab} AcpAgentsTab */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const VIEW = { installed: [], userAgents: [], registry: [], counts: { all: 0, updates: 0, off: 0 }, defaultAgent: null, errors: [], registryState: { checkedAt: null, offline: false, checking: false } };
const KNOWN = [{ id: 'claude', name: 'Claude Code' }];

describe('acp-agents-tab', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string) => unknown} */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = (cmd) =>
      cmd === 'agents_view' ? VIEW : cmd === 'agents_remove' ? { token: 't' } : cmd === 'agents_add' ? 'new-id' : cmd === 'agents_config_file' ? '/p/.brama/agents.json' : null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: /** @type {Record<string, unknown>} */ (args ?? {}) });
      return answer(cmd);
    });
    $workspace.set({ path: '/p', name: 'p', rootId: null });
  });

  afterEach(() => {
    closeAllTabs();
    $agentList.set({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] });
    $agentViews.set({});
    $signIns.set({});
    $agentsView.set(null);
    $agentsReveal.set(null);
    $agentsQuery.set({ query: '', filter: 'all' });
    $workspace.set(null);
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpAgentsTab, inner: HTMLElementTagNameMap['acp-agents-view'] }>} */
  async function render() {
    const el = /** @type {AcpAgentsTab} */ (await fixture(html`<acp-agents-tab></acp-agents-tab>`));
    return { el, inner: /** @type {HTMLElementTagNameMap['acp-agents-view']} */ (el.querySelector('acp-agents-view')) };
  }

  it('gives the agents view its data: the answer, the query, the known agents, what is pending, this project’s sign-ins, the CLI agents and the reveal', async () => {
    // Arrange
    const { el, inner } = await render();
    const reveal = { agentId: 'claude' };
    // Act
    $agentsView.set(/** @type {never} */ (VIEW));
    $agentsQuery.set({ query: 'cl', filter: 'updates' });
    $agentList.set({ agents: [], defaultAgent: null, known: /** @type {never} */ (KNOWN), userAgents: [], errors: [] });
    $agentsPending.set({ updating: ['claude'], checking: true });
    $signIns.set({ '/p\nclaude': { state: 'waiting', message: null, terminal: null }, '/other\ncodex': { state: 'failed', message: 'x', terminal: null } });
    $agentViews.set({ codex: 'terminal' });
    $agentsReveal.set(/** @type {never} */ (reveal));
    await el.updateComplete;
    // Assert
    expect(inner.view).to.equal(VIEW);
    expect(inner.query).to.deep.equal({ query: 'cl', filter: 'updates' });
    expect(inner.known).to.deep.equal(KNOWN);
    expect(inner.pending).to.deep.equal({ updating: ['claude'], checking: true });
    expect(Object.keys(inner.signIns)).to.deep.equal(['claude']);
    expect(inner.terminalAgents).to.deep.equal(['codex']);
    expect(inner.reveal === reveal).to.equal(true);
  });

  it('turns the view’s events into the agents hook’s calls, and none leaves the view', async () => {
    // Arrange
    const { el, inner } = await render();
    /** @type {Event[]} */
    const leaked = [];
    const cases = /** @type {[string, object | null, string, Record<string, unknown>][]} */ ([
      ['acp-agents-file-open', null, 'agents_config_file', {}],
      ['acp-agents-import', { agentIds: ['a'] }, 'agents_import_user', { agentIds: ['a'] }],
      ['acp-agents-query', { query: 'x', filter: 'off' }, 'agents_view', { query: 'x', filter: 'off' }],
      ['acp-agent-version-update', { agentId: 'claude' }, 'agents_update_version', { agentId: 'claude' }],
      ['acp-agents-update-all', null, 'agents_update_all', {}],
      ['acp-agents-registry-check', null, 'agents_registry_check', {}],
      ['acp-agent-enable', { agentId: 'claude', enabled: false }, 'agents_set_enabled', { agentId: 'claude', enabled: false }],
      ['acp-agent-default', { agentId: 'claude' }, 'agents_set_default', { agentId: 'claude' }],
      ['acp-agent-remove', { agentId: 'claude' }, 'agents_remove', { agentId: 'claude' }],
      ['acp-agent-sign-in', { agentId: 'claude', methodId: 'm' }, 'agents_sign_in', { agentId: 'claude', methodId: 'm' }],
    ]);
    for (const [type] of cases) el.addEventListener(type, (e) => leaked.push(e));
    for (const [type, detail, cmd, args] of cases) {
      // Act
      calls.length = 0;
      inner.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
      await until(() => calls.some((c) => c.cmd === cmd));
      // Assert
      expect(calls.find((c) => c.cmd === cmd)?.args, type).to.deep.include(args);
    }
    expect(leaked).to.deep.equal([]);
  });

  it('adds or updates an agent and tells the form that asked how it went', async () => {
    // Arrange
    const { inner } = await render();
    /** @type {(string | null)[]} */
    const finished = [];
    inner.saveFinished = (error) => finished.push(error);
    // Act
    inner.dispatchEvent(new CustomEvent('acp-agent-add', { detail: { agent: { known: 'claude' } }, bubbles: true, composed: true }));
    await until(() => finished.length === 1);
    answer = (cmd) => {
      if (cmd === 'agents_update') throw new Error('invalid command');
      return null;
    };
    inner.dispatchEvent(new CustomEvent('acp-agent-update', { detail: { agentId: 'claude', agent: { command: 'x' } }, bubbles: true, composed: true }));
    await until(() => finished.length === 2);
    // Assert
    expect(calls.map((c) => c.cmd)).to.include.members(['agents_add', 'agents_update']);
    expect(finished[0]).to.equal(null);
    expect(finished[1]).to.contain('invalid command');
  });

  it('keeps an agent’s Chat or Terminal choice and clears a shown reveal', async () => {
    // Arrange
    const { inner } = await render();
    const reveal = { agentId: 'claude' };
    $agentsReveal.set(/** @type {never} */ (reveal));
    // Act
    inner.dispatchEvent(new CustomEvent('acp-agent-session-view', { detail: { agentId: 'claude', view: 'terminal' }, bubbles: true, composed: true }));
    inner.dispatchEvent(new CustomEvent('acp-agents-revealed', { detail: { reveal }, bubbles: true, composed: true }));
    // Assert
    expect($agentViews.get()).to.deep.equal({ claude: 'terminal' });
    expect($agentsReveal.get()).to.equal(null);
  });

  it('asks for the data when the Agents tab becomes the active one, or is shown while it is', async () => {
    // Arrange
    openAgents();
    openSettings();
    await render();
    // Assert
    expect(calls.map((c) => c.cmd), 'not active').to.not.include('agents_view');
    // Act
    activateTab(AGENTS_TAB_ID);
    await until(() => calls.some((c) => c.cmd === 'agents_view'));
    calls.length = 0;
    await render();
    // Assert
    await until(() => calls.some((c) => c.cmd === 'agents_view'));
  });
});
