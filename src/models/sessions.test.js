import { expect } from '@esm-bundle/chai';
import { orderSessions, removeSessionConfirm, sessionIndicator } from './sessions.js';

/** @typedef {import('./types.js').Session} Session */

/** @type {Session} */
const SESSION = {
  id: 's',
  projectId: '/p',
  title: 'Fix the tree',
  status: 'idle',
  agentId: 'a',
  config: {},
  mode: 'local',
  folder: '/p',
  worktreePath: null,
  branch: null,
  baseCommit: null,
  createdAt: '2026-10-20T00:00:00Z',
  lastActivityAt: '2026-10-20T00:00:00Z',
  titleSource: 'prompt',
  agentTitle: null,
};

describe('sessionIndicator', () => {
  it('shows nothing for an idle or stopped session', () => {
    expect(sessionIndicator('idle', false)).to.equal(null);
    expect(sessionIndicator('stopped', false)).to.equal(null);
  });

  it('shows the agent working while it starts or runs a turn', () => {
    for (const status of /** @type {const} */ (['preparing', 'starting', 'working'])) {
      expect(sessionIndicator(status, false)).to.equal('running');
    }
  });

  it('shows a queued turn as queued, not working', () => {
    expect(sessionIndicator('queued', false)).to.equal('queued');
    expect(sessionIndicator('queued', false, true)).to.equal('queued');
  });

  it('shows a failed session as an error', () => {
    expect(sessionIndicator('error', false)).to.equal('error');
  });

  it('shows new output last, below any other status', () => {
    expect(sessionIndicator('idle', false, true)).to.equal('unread');
    expect(sessionIndicator('stopped', false, true)).to.equal('unread');
    expect(sessionIndicator('working', false, true)).to.equal('running');
    expect(sessionIndicator('error', false, true)).to.equal('error');
  });

  it('puts a pending permission request above everything else', () => {
    expect(sessionIndicator('waiting', false)).to.equal('permission');
    expect(sessionIndicator('working', true)).to.equal('permission');
    expect(sessionIndicator('error', true)).to.equal('permission');
  });
});

describe('removeSessionConfirm', () => {
  it('says a running agent is stopped and the project files stay', () => {
    const options = removeSessionConfirm({ ...SESSION, status: 'working' });
    expect(options.message).to.equal('"Fix the tree" and its conversation will be deleted, and its agent stopped.');
    expect(options.detail).to.equal('Files the agent changed in the project stay as they are.');
    expect(options.destructive).to.equal(true);
  });

  it('says where a worktree session’s uncommitted work goes', () => {
    const options = removeSessionConfirm({ ...SESSION, status: 'stopped', mode: 'worktree', branch: 'brama/fix-1' });
    expect(options.message).to.equal('"Fix the tree" and its conversation will be deleted.');
    expect(options.detail).to.contain('brama/fix-1');
  });
});

describe('orderSessions', () => {
  /**
   * @param {string} id
   * @param {string} lastActivityAt
   * @returns {Session}
   */
  const at = (id, lastActivityAt) => ({ ...SESSION, id, lastActivityAt });

  it('lists pinned sessions first, each part most recently active first', () => {
    const sessions = [at('a', '2026-01-01'), at('b', '2026-03-01'), at('c', '2026-02-01'), at('d', '2026-04-01')];
    expect(orderSessions(sessions, ['c', 'a']).map((s) => s.id)).to.deep.equal(['c', 'a', 'd', 'b']);
  });

  it('leaves the given list as it was', () => {
    const sessions = [at('a', '2026-01-01'), at('b', '2026-03-01')];
    orderSessions(sessions, []);
    expect(sessions.map((s) => s.id)).to.deep.equal(['a', 'b']);
  });
});
