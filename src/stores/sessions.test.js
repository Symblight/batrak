import { expect } from '@esm-bundle/chai';
import {
  $activeSessionId,
  $draftSessions,
  $localShared,
  $pinnedSessions,
  $sessions,
  newSession,
  removeSession,
  setProjectSessions,
  setSessionPinned,
  showProject,
  setSessionStatus,
  startSession,
  touchSession,
} from './sessions.js';

describe('sessions', () => {
  afterEach(() => {
    $sessions.set([]);
    $pinnedSessions.set([]);
    $activeSessionId.set(null);
    $draftSessions.set({});
  });

  /**
   * @param {string} id
   * @param {string} projectId
   * @param {Partial<import('../models/types.js').Session>} [fields]
   * @returns {import('../models/types.js').Session}
   */
  const listed = (id, projectId, fields = {}) => ({
    id,
    projectId,
    title: id,
    titleSource: 'agent',
    agentTitle: id,
    status: 'stopped',
    agentId: 'a',
    config: {},
    mode: 'local',
    folder: projectId,
    worktreePath: null,
    branch: null,
    baseCommit: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  });

  it("replaces a project's sessions with a sync's, keeping other projects' and its sessions being created", () => {
    $sessions.set([listed('old', '/p'), listed('other', '/q')]);
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    setProjectSessions('/p', [listed('t1', '/p'), listed('t2', '/p')]);
    expect($sessions.get().map((s) => s.id).sort()).to.deep.equal([id, 'other', 't1', 't2'].sort());
  });

  it('comes back to the last shown session once a sync lists it, unless the user moved on', () => {
    $sessions.set([listed('a', '/p')]);
    $activeSessionId.set('a');
    $sessions.set([]);
    $activeSessionId.set(null);
    showProject('/p');
    const draft = $activeSessionId.get();
    expect(draft !== null && draft in $draftSessions.get(), 'a draft meanwhile').to.equal(true);
    setProjectSessions('/p', [listed('a', '/p'), listed('b', '/p')]);
    expect($activeSessionId.get()).to.equal('a');

    $activeSessionId.set(null);
    showProject('/r');
    const chosen = newSession('/r');
    $sessions.set([...$sessions.get(), listed('c', '/r')]);
    $activeSessionId.set('c');
    $activeSessionId.set(chosen);
    setProjectSessions('/r', [listed('c', '/r')]);
    expect($activeSessionId.get(), 'a draft the user opened stays').to.equal(chosen);
  });

  it("counts the other local sessions running in the active session's project", () => {
    /** @param {string} project @param {'local' | 'worktree'} mode @param {import('../models/types.js').SessionStatus} status */
    const add = (project, mode, status) => {
      const id = newSession(project);
      startSession(id, { title: 'T', agentId: 'a', config: {}, mode });
      setSessionStatus(id, status);
      return id;
    };
    add('/p', 'local', 'working');
    add('/p', 'local', 'idle');
    add('/p', 'local', 'stopped');
    add('/p', 'worktree', 'working');
    add('/q', 'local', 'working');
    const draft = newSession('/p');
    $activeSessionId.set(draft);
    expect($localShared.get(), 'from a draft').to.equal(2);
    $activeSessionId.set(add('/p', 'local', 'queued'));
    expect($localShared.get(), 'not counting itself').to.equal(2);
  });

  it('starts a session active as of its creation', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    const [session] = $sessions.get();
    expect(session.lastActivityAt).to.equal(session.createdAt);
    expect([session.titleSource, session.agentTitle]).to.deep.equal(['prompt', null]);
  });

  it('marks a session active now', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    touchSession(id, '2099-01-01T00:00:00.000Z');
    expect($sessions.get()[0].lastActivityAt).to.equal('2099-01-01T00:00:00.000Z');
  });

  it('pins and unpins a session, and forgets the pin of a removed one', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    setSessionPinned(id, true);
    setSessionPinned(id, true);
    expect($pinnedSessions.get()).to.deep.equal([id]);
    setSessionPinned(id, false);
    expect($pinnedSessions.get()).to.deep.equal([]);

    setSessionPinned(id, true);
    removeSession(id);
    expect($pinnedSessions.get()).to.deep.equal([]);
  });
});
