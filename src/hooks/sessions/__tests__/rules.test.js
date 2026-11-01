import { expect } from '@esm-bundle/chai';
import {
  ageLabel,
  inTurn,
  isActiveElsewhere,
  isUnread,
  loadingProjects,
  orderSessions,
  ownView,
  removeSessionConfirm,
  sessionIndicator,
  syncSummary,
  unreadIn,
  viewDisabledReason,
  viewOf,
  visibleSessions,
} from '../rules.js';

/** @typedef {import('../types.js').Session} Session */

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

describe('sessions model', () => {
  it('shows one indicator per session: a permission request above all, then failure, running, queued, elsewhere and the terminal', () => {
    /** @type {any[][]} */
    const cases = [
      // [status, permission, elsewhere, terminal, indicator, why]
      ['idle', false, false, false, null, 'idle shows nothing'],
      ['stopped', false, false, false, null, 'stopped shows nothing'],
      ['preparing', false, false, false, 'running', 'starting up works'],
      ['starting', false, false, false, 'running', 'starting works'],
      ['working', false, false, false, 'running', 'a turn works'],
      ['queued', false, false, false, 'queued', 'queued is not working'],
      ['error', false, false, false, 'error', 'a failure'],
      ['stopped', false, true, false, 'elsewhere', 'another app runs it'],
      ['error', false, true, false, 'error', 'a failure above elsewhere'],
      ['waiting', false, false, false, 'permission', 'waiting for an answer'],
      ['working', true, false, false, 'permission', 'a permission above working'],
      ['error', true, false, false, 'permission', 'a permission above a failure'],
      ['stopped', false, false, true, 'terminal', 'the CLI runs it'],
      ['stopped', false, true, true, 'terminal-working', 'the CLI works'],
      ['error', false, true, true, 'error', 'a failure above the CLI'],
    ];
    for (const [status, permission, elsewhere, terminal, indicator, why] of cases) {
      // Act + Assert
      expect(sessionIndicator(/** @type {any} */ (status), /** @type {boolean} */ (permission), /** @type {boolean} */ (elsewhere), /** @type {boolean} */ (terminal)), why).to.equal(indicator);
    }
  });

  it('is unread when marked so, or when its activity came more than the slack after it was seen, or after its baseline when never seen', () => {
    /** @param {string} at @param {Partial<Session>} [rest] */
    const at = (at, rest = {}) => ({ ...SESSION, lastActivityAt: at, ...rest });
    const SEEN = '2026-10-20T10:00:00.000Z';
    /** @type {[Session, import('../types.js').SessionRead | undefined, string | undefined, boolean, string][]} */
    const cases = [
      [at('2026-10-20T10:00:06.000Z'), { seen: SEEN }, undefined, true, 'activity after it was seen'],
      [at('2026-10-20T10:00:05.000Z'), { seen: SEEN }, undefined, false, 'exactly the slack after: the agent\'s trailing write'],
      [at('2026-10-20T09:59:00.000Z'), { seen: SEEN }, undefined, false, 'activity before it was seen'],
      [at('2026-10-20T09:00:00.000Z'), { seen: null }, undefined, true, 'marked unread by hand, whatever the activity'],
      [at('2026-10-20T10:00:06Z'), { seen: SEEN }, undefined, true, 'times compared as dates: no milliseconds'],
      [at('2026-10-20T10:00:04Z'), { seen: '2026-10-20T10:00:00Z' }, undefined, false, 'mixed formats within the slack'],
      [at('2026-10-20T10:00:06.5+00:00'), { seen: SEEN }, undefined, true, 'an offset instead of Z'],
      [at('2026-10-20T10:00:10.000Z'), undefined, SEEN, true, 'never seen, active after its baseline'],
      [at('2026-10-20T10:00:03.000Z'), undefined, SEEN, false, 'never seen, within the slack of its baseline'],
      [at('2026-10-20T09:00:00.000Z'), undefined, SEEN, false, 'never seen, older than its baseline'],
      [at('2026-10-20T11:00:00.000Z'), undefined, undefined, false, 'no mark and no baseline (the agent can\'t list)'],
      [at('2026-10-20T10:00:10.000Z', { status: 'working' }), { seen: SEEN }, undefined, true, 'running, with new output'],
      [at('2026-10-20T10:00:01.000Z', { status: 'working' }), { seen: SEEN }, undefined, false, 'running, without new output'],
      [at('2026-10-20T10:00:10.000Z', { status: 'working' }), undefined, SEEN, true, 'running, never seen, with output'],
      [at('2026-10-20T10:00:10.000Z', { status: 'preparing' }), undefined, SEEN, false, 'preparing: its stamp is the prompt, not output'],
      [at('2026-10-20T10:00:10.000Z', { status: 'starting' }), undefined, SEEN, false, 'starting: the same'],
      [at('2026-10-20T10:00:10.000Z', { status: 'queued' }), undefined, SEEN, false, 'queued: the same'],
      [at('2026-10-20T10:00:10.000Z', { status: 'queued' }), { seen: null }, SEEN, true, 'queued, but already marked unread'],
    ];
    for (const [session, read, baseline, expected, why] of cases) {
      // Act + Assert
      expect(isUnread(session, read, baseline), why).to.equal(expected);
    }
  });

  it('counts a project\'s unread sessions, and those past the ones its list shows', () => {
    const list = ['a', 'b', 'c', 'd'].map((id) => ({ ...SESSION, id }));
    expect(unreadIn(list, ['b', 'd', 'other'], 2)).to.deep.equal({ count: 2, hidden: 1 });
    expect(unreadIn(list, ['a', 'b'], 2), 'all shown unread').to.deep.equal({ count: 2, hidden: 0 });
    expect(unreadIn(list, ['d']), 'nothing hidden without a limit').to.deep.equal({ count: 1, hidden: 0 });
    expect(unreadIn([], ['a'])).to.deep.equal({ count: 0, hidden: 0 });
  });

  it('words a session\'s age for its accessible name, like the compact age of the row', () => {
    // Arrange
    const now = Date.parse('2026-10-20T12:00:00Z');
    /** @type {[string, string][]} */
    const cases = [
      ['2026-10-20T11:59:30Z', 'just now'],
      ['2026-10-20T11:59:00Z', '1 minute ago'],
      ['2026-10-20T11:47:00Z', '13 minutes ago'],
      ['2026-10-20T11:00:00Z', '1 hour ago'],
      ['2026-10-20T07:00:00Z', '5 hours ago'],
      ['2026-10-18T12:00:00Z', '2 days ago'],
      ['2026-10-21T12:00:00Z', 'just now'],
      ['not a time', ''],
    ];
    for (const [at, label] of cases) {
      // Act + Assert
      expect(ageLabel(at, now), at).to.equal(label);
    }
  });

  it("picks the session's view: its own over the setting, chat without a terminal mode, a draft's terminal only when the CLI can start", () => {
    const both = { resume: true, new: true };
    const resumeOnly = { resume: true, new: false };
    /** @type {any[][]} */
    const cases = [
      // [own, setting, mode, draft, view, why]
      ['terminal', 'chat', both, false, 'terminal', 'its own'],
      ['chat', 'terminal', both, false, 'chat', 'its own'],
      [undefined, 'terminal', both, false, 'terminal', 'the setting'],
      [undefined, 'chat', both, false, 'chat', 'the setting'],
      ['terminal', 'terminal', null, false, 'chat', 'no terminal mode'],
      ['terminal', 'terminal', undefined, false, 'chat', 'no terminal mode'],
      [undefined, 'terminal', resumeOnly, true, 'chat', 'a draft cannot start there'],
      [undefined, 'terminal', both, true, 'terminal', 'a draft can'],
    ];
    for (const [own, setting, mode, draft, view, why] of cases) {
      // Act + Assert
      expect(viewOf(/** @type {any} */ (own), /** @type {any} */ (setting), /** @type {any} */ (mode), /** @type {boolean} */ (draft)), why).to.equal(view);
    }
  });

  it('forgets a view choice that is what the setting says, and says why the view button is disabled', () => {
    const resumeOnly = { resume: true, new: false };
    expect(ownView('chat', 'chat')).to.equal(undefined);
    expect(ownView('terminal', 'chat')).to.equal('terminal');
    expect(viewDisabledReason(null, false, 'Copilot')).to.equal('Copilot has no terminal mode');
    expect(viewDisabledReason(resumeOnly, true, 'Codex')).to.equal('Send a first message, then continue in the terminal');
    expect(viewDisabledReason(resumeOnly, false, 'Codex')).to.equal('');
  });

  it('asks before removing: deleted in its agent, a running agent stopped, files stay; a worktree’s work goes to its branch', () => {
    // Act
    const running = removeSessionConfirm({ ...SESSION, status: 'working', agentName: 'Claude Code' });
    const worktree = removeSessionConfirm({ ...SESSION, status: 'stopped', mode: 'worktree', branch: 'brama/fix-1' });
    // Assert
    expect(running.message).to.equal('"Fix the tree" will be deleted from Claude Code, for every app that uses it, and its agent stopped.');
    expect(running.detail).to.equal('Files the agent changed in the project stay as they are.');
    expect(running.destructive).to.equal(true);
    expect(worktree.message).to.equal('"Fix the tree" will be deleted from its agent, for every app that uses it.');
    expect(worktree.detail).to.contain('brama/fix-1');
  });

  it('lists pinned sessions first, each part most recently active first, leaving the given list as it was', () => {
    // Arrange
    /** @param {string} id @param {string} lastActivityAt @returns {Session} */
    const at = (id, lastActivityAt) => ({ ...SESSION, id, lastActivityAt });
    const sessions = [at('a', '2026-01-01'), at('b', '2026-03-01'), at('c', '2026-02-01'), at('d', '2026-04-01')];
    // Act
    const ordered = orderSessions(sessions, ['c', 'a']).map((s) => s.id);
    // Assert
    expect(ordered).to.deep.equal(['c', 'a', 'd', 'b']);
    expect(sessions.map((s) => s.id), 'untouched').to.deep.equal(['a', 'b', 'c', 'd']);
  });

  it('sums up a sync: not yet, running, when it ended and how each agent did, warning when one needs the user', () => {
    // Arrange
    /** @type {import('../types.js').SyncReport} */
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
    const one = { ...report, agents: [{ ...report.agents[0], count: 1 }, report.agents[2]] };
    // Act + Assert
    expect(syncSummary({ running: false, report: null }, now)).to.deep.equal({ label: 'Not synced yet', lines: [], warn: false });
    expect(syncSummary({ running: true, report: null }, now).label).to.equal('Syncing sessions…');
    expect(syncSummary({ running: false, report }, now)).to.deep.equal({
      label: 'Synced 3 min ago',
      lines: ['Claude Code · 12 sessions', 'Codex · needs sign-in', "Copilot · can't list sessions", 'Antigravity · failed: no answer'],
      warn: true,
    });
    expect(syncSummary({ running: false, report: one }, Date.parse(one.endedAt) + 5_000)).to.deep.equal({
      label: 'Synced just now',
      lines: ['Claude Code · 1 session', "Copilot · can't list sessions"],
      warn: false,
    });
  });

  it('shows the first `limit` sessions and counts the rest, reaching down to the selected one', () => {
    /** @param {string[]} ids */
    const of = (ids) => ids.map((id) => ({ ...SESSION, id }));
    const ten = of(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    /** @type {any[][]} */
    const cases = [
      // [sessions, selected, shown, hidden, why]
      [ten, null, 'abcde', 5, 'the first five'],
      [of(['a', 'b']), null, 'ab', 0, 'all fit'],
      [ten, 'g', 'abcdefg', 3, 'up to the selected one'],
    ];
    for (const [sessions, selected, shown, hidden, why] of cases) {
      // Act
      const result = visibleSessions(/** @type {Session[]} */ (sessions), 5, /** @type {string | null} */ (selected));
      // Assert
      expect(result.shown.map((x) => x.id).join(''), why).to.equal(shown);
      expect(result.hidden, why).to.equal(hidden);
    }
  });

  it('loads every project until the stored list arrives, then each project in its first sync', () => {
    const projects = ['/p', '/q', '/r'];
    /** @type {import('../types.js').SyncReport} */
    const report = { projectPath: '/q', startedAt: 'a', endedAt: 'b', agents: [] };
    const syncs = { '/p': { running: true, report: null }, '/q': { running: true, report }, '/r': { running: false, report: null } };
    expect(loadingProjects(projects, false, {})).to.deep.equal(projects);
    expect(loadingProjects(projects, true, syncs)).to.deep.equal(['/p']);
  });

  it('is active elsewhere until its time is up, never when it runs here or has no outside activity', () => {
    const now = Date.parse('2026-10-23T13:00:00.000Z');
    const until = '2026-10-23T13:01:00.000Z';
    /** @type {any[][]} */
    const cases = [
      // [session, at, active, why]
      [{ ...SESSION, status: 'stopped', activeElsewhereUntil: until }, now, true, 'time left'],
      [{ ...SESSION, status: 'stopped', activeElsewhereUntil: until }, Date.parse(until), false, 'over'],
      [{ ...SESSION, status: 'idle', activeElsewhereUntil: until }, now, false, 'runs here'],
      [{ ...SESSION, status: 'stopped', activeElsewhereUntil: null }, now, false, 'no outside activity'],
      [{ ...SESSION, status: 'stopped' }, now, false, 'never seen'],
    ];
    for (const [session, at, active, why] of cases) {
      // Act + Assert
      expect(isActiveElsewhere(/** @type {Session} */ (session), /** @type {number} */ (at)), why).to.equal(active);
    }
  });

  it('is in a turn when working, queued or waiting for an answer, or a permission is asked', () => {
    /** @type {any[][]} */
    const cases = [
      // [status, permission, in a turn]
      ['working', false, true],
      ['queued', false, true],
      ['waiting', false, true],
      ['idle', false, false],
      ['stopped', false, false],
      ['starting', false, false],
      ['idle', true, true],
      [null, false, false],
    ];
    for (const [status, permission, inside] of cases) {
      // Act + Assert
      expect(inTurn(/** @type {any} */ (status), /** @type {boolean} */ (permission)), `${status} ${permission}`).to.equal(inside);
    }
  });
});
