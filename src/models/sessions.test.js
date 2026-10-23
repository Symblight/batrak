import { expect } from '@esm-bundle/chai';
import { orderSessions, removeSessionConfirm, sessionIndicator, syncSummary } from './sessions.js';

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

  it('shows a session another app may be running, below a failure and above new output', () => {
    expect(sessionIndicator('stopped', false, false, true)).to.equal('elsewhere');
    expect(sessionIndicator('stopped', false, true, true)).to.equal('elsewhere');
    expect(sessionIndicator('error', false, false, true)).to.equal('error');
  });

  it('puts a pending permission request above everything else', () => {
    expect(sessionIndicator('waiting', false)).to.equal('permission');
    expect(sessionIndicator('working', true)).to.equal('permission');
    expect(sessionIndicator('error', true)).to.equal('permission');
  });
});

describe('removeSessionConfirm', () => {
  it('says the session is deleted in its agent, a running agent is stopped and the project files stay', () => {
    const options = removeSessionConfirm({ ...SESSION, status: 'working', agentName: 'Claude Code' });
    expect(options.message).to.equal(
      '"Fix the tree" will be deleted from Claude Code, for every app that uses it, and its agent stopped.',
    );
    expect(options.detail).to.equal('Files the agent changed in the project stay as they are.');
    expect(options.destructive).to.equal(true);
  });

  it('says where a worktree session’s uncommitted work goes', () => {
    const options = removeSessionConfirm({ ...SESSION, status: 'stopped', mode: 'worktree', branch: 'brama/fix-1' });
    expect(options.message).to.equal('"Fix the tree" will be deleted from its agent, for every app that uses it.');
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

describe('syncSummary', () => {
  /** @type {import('./types.js').SyncReport} */
  const report = {
    projectPath: '/p',
    startedAt: '2026-10-23T10:00:00.000Z',
    endedAt: '2026-10-23T10:00:02.000Z',
    agents: [
      { agentId: 'claude', agentName: 'Claude Code', outcome: 'listed', count: 12, error: null },
      { agentId: 'codex', agentName: 'Codex', outcome: 'signIn', count: null, error: null },
      { agentId: 'copilot', agentName: 'Copilot', outcome: 'unsupported', count: null, error: null },
      { agentId: 'agy', agentName: 'Antigravity', outcome: 'failed', count: null, error: 'no answer' },
    ],
  };
  const now = Date.parse('2026-10-23T10:03:30.000Z');

  it('says nothing before the first sync, and that one runs', () => {
    expect(syncSummary({ running: false, report: null }, now)).to.deep.equal({ label: 'Not synced yet', lines: [], warn: false });
    expect(syncSummary({ running: true, report: null }, now).label).to.equal('Syncing sessions…');
  });

  it('says when it last synced and how each agent did, warning when one needs the user', () => {
    expect(syncSummary({ running: false, report }, now)).to.deep.equal({
      label: 'Synced 3 min ago',
      lines: ['Claude Code · 12 sessions', 'Codex · needs sign-in', "Copilot · can't list sessions", 'Antigravity · failed: no answer'],
      warn: true,
    });
  });

  it('counts one session, says just now, and warns of nothing when all listed or can’t list', () => {
    const one = { ...report, agents: [{ ...report.agents[0], count: 1 }, report.agents[2]] };
    const summary = syncSummary({ running: false, report: one }, Date.parse(one.endedAt) + 5_000);
    expect(summary).to.deep.equal({ label: 'Synced just now', lines: ['Claude Code · 1 session', "Copilot · can't list sessions"], warn: false });
  });
});
