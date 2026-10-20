import { expect } from '@esm-bundle/chai';
import { $agentList } from './agents.js';
import { $composer, agentInfo, setRunTarget } from './composer.js';
import { $activeSessionId, newSession } from './sessions.js';

describe('composer', () => {
  afterEach(() => {
    $agentList.set({ agents: [], defaultAgent: null, errors: [] });
    $activeSessionId.set(null);
  });

  it('has no agent while the project configures none', () => {
    $agentList.set({ agents: [], defaultAgent: null, errors: [] });
    expect($composer.get().agentId).to.equal(null);
    expect(agentInfo(null)).to.equal(null);
  });

  it("starts with the project's default agent", () => {
    $agentList.set({ agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], defaultAgent: 'b', errors: [] });
    expect($composer.get().agentId).to.equal('b');
    expect(agentInfo('b')?.name).to.equal('B');
  });

  it('gives a draft changed before any agent existed the agent added later', () => {
    $agentList.set({ agents: [], defaultAgent: null, errors: [] });
    newSession('/p');
    setRunTarget({ kind: 'worktree' });
    expect($composer.get().agentId).to.equal(null);

    $agentList.set({ agents: [{ id: 'a', name: 'A' }], defaultAgent: 'a', errors: [] });
    expect($composer.get().agentId).to.equal('a');
    expect($composer.get().runTarget.kind).to.equal('worktree', 'keeps what the draft changed');
  });
});
