import { expect } from '@esm-bundle/chai';
import { $agentList } from './agents.js';
import { $agents, $composer, agentInfo, applyAgentOptions, selectAgent, setRunTarget, startComposer } from './composer.js';
import { $activeSessionId, $sessions, newSession, startSession, upsertSession } from './sessions.js';
import { setWorkspaceSettings } from './workspace.js';

/**
 * @param {string} id
 * @param {string} name
 * @returns {import('../models/types.js').AgentSummary}
 */
const agent = (id, name) => ({ id, name, scope: 'user', version: null, enabled: true, command: id, args: [] });

describe('composer', () => {
  afterEach(() => {
    $agentList.set({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] });
    $activeSessionId.set(null);
    setWorkspaceSettings(null);
  });

  it('has no agent while the project configures none', () => {
    $agentList.set({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId).to.equal(null);
    expect(agentInfo(null)).to.equal(null);
  });

  it("starts with the project's default agent", () => {
    $agentList.set({ agents: [agent('a', 'A'), agent('b', 'B')], defaultAgent: 'b', known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId).to.equal('b');
    expect(agentInfo('b')?.name).to.equal('B');
  });

  it('gives a draft changed before any agent existed the agent added later', () => {
    $agentList.set({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] });
    newSession('/p');
    setRunTarget({ kind: 'worktree' });
    expect($composer.get().agentId).to.equal(null);

    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId).to.equal('a');
    expect($composer.get().runTarget.kind).to.equal('worktree', 'keeps what the draft changed');
  });

  it('moves a draft off an agent agents.json no longer has', () => {
    $agentList.set({ agents: [agent('a', 'A'), agent('b', 'B')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    newSession('/p');
    selectAgent('b');
    setRunTarget({ kind: 'worktree' });
    expect($composer.get().agentId).to.equal('b');

    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId, 'removed from the file').to.equal('a');
    expect($composer.get().runTarget.kind).to.equal('worktree', 'keeps what the draft changed');
    expect($agents.get().map((x) => x.id)).to.deep.equal(['a']);
  });

  it('never gives a new session or a draft an agent the user turned off', () => {
    const off = { ...agent('b', 'B'), enabled: false };
    $agentList.set({ agents: [agent('a', 'A'), agent('b', 'B')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    newSession('/p');
    selectAgent('b');
    expect($composer.get().agentId).to.equal('b');

    $agentList.set({ agents: [agent('a', 'A'), off], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId, 'the draft moves on').to.equal('a');
    newSession('/p');
    expect($composer.get().agentId, 'the last pick is off: not for a new session').to.equal('a');
    expect(agentInfo('b')).to.include({ name: 'B', off: true });
  });

  it("gives a draft the project's run target once workspace.json is read, until the user picks one", () => {
    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    const id = newSession('/settings');
    // The agent's options arrive before the project's workspace.json is read.
    applyAgentOptions(id, []);
    expect($composer.get().runTarget.kind).to.equal('local');

    setWorkspaceSettings({ defaultMode: 'worktree', localTurns: 'queue' });
    expect($composer.get().runTarget.kind).to.equal('worktree');

    setRunTarget({ kind: 'local' });
    setWorkspaceSettings({ defaultMode: 'worktree', localTurns: 'queue' });
    expect($composer.get().runTarget.kind).to.equal('local', 'keeps what the user picked');
  });

  it('counts a base branch pick as picking the run target', () => {
    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    setWorkspaceSettings({ defaultMode: 'worktree', localTurns: 'queue' });
    newSession('/branch-pick');
    setRunTarget({ branch: 'dev' });

    setWorkspaceSettings({ defaultMode: 'local', localTurns: 'queue' });
    expect($composer.get().runTarget).to.deep.equal({ kind: 'worktree', branch: 'dev' });
  });

  it("follows a started session's agent to the id the backend moved it to", () => {
    $agentList.set({ agents: [agent('claude', 'Claude'), agent('claude-code', 'Claude Code')], defaultAgent: null, known: [], userAgents: [], errors: [] });
    const id = newSession('/started');
    $activeSessionId.set(id);
    selectAgent('claude');
    setRunTarget({ kind: 'worktree' });
    startSession(id, { title: 'T', agentId: 'claude', config: {}, mode: 'local' });
    startComposer(id);
    expect($composer.get().agentId).to.equal('claude');

    $agentList.set({ agents: [agent('claude-code', 'Claude Code')], defaultAgent: null, known: [], userAgents: [], errors: [] });
    upsertSession({ ...$sessions.get()[0], agentId: 'claude-code' });
    expect($composer.get().agentId).to.equal('claude-code');
    expect($composer.get().started).to.equal(true);
    $sessions.set([]);
  });

  it('names an agent agents.json no longer has as the session knew it', () => {
    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: null, known: [], userAgents: [], errors: [] });
    expect(agentInfo('a')).to.deep.include({ name: 'A', removed: false });
    expect(agentInfo('claude', 'Claude Code')).to.deep.include({ id: 'claude', name: 'Claude Code', glyph: 'CC', removed: true });
    expect(agentInfo('claude')).to.deep.include({ name: 'claude', removed: true });
  });
});
