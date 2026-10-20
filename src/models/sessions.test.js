import { expect } from '@esm-bundle/chai';
import { removeSessionConfirm, sessionIndicator } from './sessions.js';

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

  it('shows a failed session as an error', () => {
    expect(sessionIndicator('error', false)).to.equal('error');
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
