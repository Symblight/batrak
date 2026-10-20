import { expect } from '@esm-bundle/chai';
import { $agentList } from './agents.js';
import { $composer, agentInfo } from './composer.js';

describe('composer', () => {
  afterEach(() => $agentList.set({ agents: [], defaultAgent: null, errors: [] }));

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
});
