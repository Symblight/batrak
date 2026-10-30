import { expect } from '@esm-bundle/chai';
import { $sessionSync, endSync, startSync, syncOf } from './session-sync.js';

/** @type {import('../models/types.js').SyncReport} */
const REPORT = { projectPath: '/p', startedAt: 'a', endedAt: 'b', agents: [] };

describe('session-sync', () => {
  afterEach(() => $sessionSync.set({}));

  it('keeps each project\'s sync: running, then its report', () => {
    expect(syncOf('/p')).to.deep.equal({ running: false, report: null });
    startSync('/p');
    expect(syncOf('/p')).to.deep.equal({ running: true, report: null });
    endSync('/p', REPORT);
    expect(syncOf('/p')).to.deep.equal({ running: false, report: REPORT });
    expect(syncOf('/q').report).to.equal(null);
  });

  it('keeps the last report when a sync fails', () => {
    endSync('/p', REPORT);
    startSync('/p');
    endSync('/p', null);
    expect(syncOf('/p')).to.deep.equal({ running: false, report: REPORT });
  });

  /**
   * @param {string} agentId
   * @param {import('../models/types.js').SyncOutcome} outcome
   * @returns {import('../models/types.js').AgentSync}
   */
  const agent = (agentId, outcome) => ({ agentId, agentName: agentId, outcome, count: null, error: null });

  it('merges a report of some agents into the last one, by agent', () => {
    endSync('/p', { ...REPORT, agents: [agent('a', 'listed'), agent('b', 'failed'), agent('c', 'signIn')] });
    endSync('/p', { projectPath: '/p', startedAt: 'c', endedAt: 'd', agents: [agent('b', 'listed'), agent('d', 'off')] });
    expect(syncOf('/p').report).to.deep.equal({
      projectPath: '/p',
      startedAt: 'c',
      endedAt: 'd',
      agents: [agent('a', 'listed'), agent('b', 'listed'), agent('c', 'signIn'), agent('d', 'off')],
    });
  });

  it('keeps the merged report when a later sync fails', () => {
    endSync('/p', { ...REPORT, agents: [agent('a', 'failed')] });
    endSync('/p', { ...REPORT, agents: [agent('b', 'listed')] });
    endSync('/p', null);
    expect(syncOf('/p').report?.agents).to.deep.equal([agent('a', 'failed'), agent('b', 'listed')]);
  });
});
