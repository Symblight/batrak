import { expect } from '@esm-bundle/chai';
import { $agentList } from '../../agents/agents.js';
import {
  $agents,
  $composer,
  $composerOptionsStatus,
  agentInfo,
  normalizeOptions,
  selectAgent,
  setRunTarget,
  startComposer,
  whileLoadingOptions,
} from '../composer.js';
import { $activeSessionId, $sessions, newSession, startSession, upsertSession } from '../../sessions/sessions.js';

/**
 * @param {string} id
 * @param {string} name
 * @returns {import('../../../hooks/agents/types.js').AgentSummary}
 */
const agent = (id, name) => ({ id, name, scope: 'user', version: null, registryId: null, update: null, enabled: true, signIn: false, command: id, args: [] });

describe('composer', () => {
  afterEach(() => {
    $agentList.set({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] });
    $activeSessionId.set(null);
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

  it('gives a draft made before any agent existed the agent added later', () => {
    $agentList.set({ agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] });
    newSession('/p');
    expect($composer.get().agentId).to.equal(null);

    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId).to.equal('a');
  });

  it('moves a draft off an agent agents.json no longer has', () => {
    $agentList.set({ agents: [agent('a', 'A'), agent('b', 'B')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    newSession('/p');
    selectAgent('b');
    expect($composer.get().agentId).to.equal('b');

    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    expect($composer.get().agentId, 'removed from the file').to.equal('a');
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

  it("keeps each draft's picked place, through switching drafts and agents, and the agent it was picked with when that goes", () => {
    // Arrange
    $agentList.set({ agents: [agent('a', 'A'), agent('b', 'B')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    const first = newSession('/p');
    const second = newSession('/p', 'w1');

    // Act
    setRunTarget(first, { kind: 'worktree', base: 'dev' });
    $activeSessionId.set(first);
    selectAgent('b');
    const afterAgent = $composer.get().runTarget;
    $agentList.set({ agents: [agent('a', 'A')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    const afterGone = $composer.get().runTarget;
    $activeSessionId.set(second);

    // Assert
    expect([afterAgent, afterGone], 'kept through an agent pick, and its agent going').to.deep.equal([
      { kind: 'worktree', base: 'dev' },
      { kind: 'worktree', base: 'dev' },
    ]);
    expect($composer.get().runTarget, "the other draft's: none picked").to.equal(undefined);
  });

  it('says which agent asks to sign in', () => {
    $agentList.set({ agents: [agent('a', 'A'), { ...agent('b', 'B'), signIn: true }], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    expect(agentInfo('a')).to.include({ signIn: false });
    expect(agentInfo('b')).to.include({ signIn: true });
  });

  it("follows a started session's agent to the id the backend moved it to", () => {
    $agentList.set({ agents: [agent('claude', 'Claude'), agent('claude-code', 'Claude Code')], defaultAgent: null, known: [], userAgents: [], errors: [] });
    const id = newSession('/started');
    $activeSessionId.set(id);
    selectAgent('claude');
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
    expect(agentInfo('claude', 'Claude Code')).to.deep.include({ id: 'claude', name: 'Claude Code', removed: true });
    expect(agentInfo('claude')).to.deep.include({ name: 'claude', removed: true });
  });

  it("keeps one of each value an agent sends twice, and no description that only repeats the name", () => {
    const [model] = normalizeOptions([
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' },
          { value: 'auto', name: 'Auto', description: 'Auto' },
          { value: 'gpt-5', name: 'GPT-5', description: 'gpt-5' },
        ],
      },
    ]);
    expect(model.options).to.deep.equal([
      { value: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' },
      { value: 'gpt-5', name: 'GPT-5' },
    ]);
  });

  it("keeps the risk the backend tagged a mode with, and only a known one", () => {
    const [mode] = normalizeOptions([
      {
        type: 'select',
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        currentValue: 'plan',
        options: [
          { value: 'plan', name: 'Plan', risk: 'plan' },
          { value: 'yolo', name: 'Yolo', risk: 'full' },
          { value: 'odd', name: 'Odd', risk: 'reckless' },
        ],
      },
    ]);
    expect(mode.options).to.deep.equal([
      { value: 'plan', name: 'Plan', risk: 'plan' },
      { value: 'yolo', name: 'Yolo', risk: 'full' },
      { value: 'odd', name: 'Odd' },
    ]);
  });

  it("says while the composer's agent's options load, and when that failed", async () => {
    $agentList.set({ agents: [agent('a', 'A'), agent('b', 'B')], defaultAgent: 'a', known: [], userAgents: [], errors: [] });
    // A new session's agent may be the one last picked in an earlier test.
    const shown = /** @type {string} */ ($composer.get().agentId);
    const other = shown === 'a' ? 'b' : 'a';
    /** @type {(loaded: boolean) => void} */
    let finish = () => {};
    const loading = whileLoadingOptions(shown, () => new Promise((resolve) => (finish = resolve)));
    expect($composerOptionsStatus.get()).to.equal('loading');
    finish(true);
    await loading;
    expect($composerOptionsStatus.get()).to.equal(null);

    await whileLoadingOptions(shown, () => Promise.reject(new Error('not installed'))).catch(() => {});
    expect($composerOptionsStatus.get()).to.equal('failed');
    await whileLoadingOptions(other, () => Promise.resolve(false));
    expect($composerOptionsStatus.get(), "another agent's").to.equal('failed');
    await whileLoadingOptions(shown, () => Promise.resolve(true));
    expect($composerOptionsStatus.get()).to.equal(null);
  });
});
