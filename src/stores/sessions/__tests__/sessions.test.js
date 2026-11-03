import { expect } from '@esm-bundle/chai';
import {
  $activeSessionId,
  $draftSessions,
  $pinnedSessions,
  $sessions,
  newSession,
  removeSession,
  revertToDraft,
  setProjectSessions,
  setSessionPinned,
  showWorkspace,
  workspaceOf,
  startSession,
  touchSession,
} from '../sessions.js';

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
   * @param {Partial<import('../../../hooks/sessions/types.js').Session>} [fields]
   * @returns {import('../../../hooks/sessions/types.js').Session}
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
    showWorkspace('/p', 'main', '/p');
    const draft = $activeSessionId.get();
    expect(draft !== null && draft in $draftSessions.get(), 'a draft meanwhile').to.equal(true);
    setProjectSessions('/p', [listed('a', '/p'), listed('b', '/p')]);
    expect($activeSessionId.get()).to.equal('a');

    $activeSessionId.set(null);
    showWorkspace('/r', 'main', '/r');
    const chosen = newSession('/r');
    $sessions.set([...$sessions.get(), listed('c', '/r')]);
    $activeSessionId.set('c');
    $activeSessionId.set(chosen);
    setProjectSessions('/r', [listed('c', '/r')]);
    expect($activeSessionId.get(), 'a draft the user opened stays').to.equal(chosen);
  });

  it("shows a workspace's last shown chat, else its newest, else a new draft of it; its drafts stay its own", () => {
    // Arrange
    $sessions.set([
      listed('main-old', '/p'),
      listed('ws-old', '/p', { workspaceId: 'w1', folder: '/wt/w1', createdAt: '2026-01-01T00:00:00.000Z' }),
      listed('ws-new', '/p', { workspaceId: 'w1', folder: '/wt/w1', createdAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    $activeSessionId.set('ws-old');
    $activeSessionId.set('main-old');

    // Act
    const shown = [];
    showWorkspace('/p', 'w1', '/wt/w1');
    shown.push($activeSessionId.get());
    showWorkspace('/p', 'w1', '/wt/w1');
    shown.push($activeSessionId.get());
    $activeSessionId.set(null);
    showWorkspace('/p', 'w1', null);
    shown.push($activeSessionId.get());
    showWorkspace('/p', 'w2', '/wt/w2');
    const draft = /** @type {string} */ ($activeSessionId.get());
    showWorkspace('/p', 'main', '/p');
    shown.push($activeSessionId.get());
    const reused = newSession('/p', 'w2');
    const mainDraft = newSession('/p', 'main');

    // Assert
    expect(shown, 'its last, kept while shown, its newest, Main\'s last').to.deep.equal(['ws-old', 'ws-old', 'ws-new', 'main-old']);
    expect([workspaceOf(draft), reused], "a draft of w2, reused for w2's next new chat").to.deep.equal(['w2', draft]);
    expect([workspaceOf(mainDraft), mainDraft === draft], "Main's new chat is its own").to.deep.equal(['main', false]);
  });

  it("brings a refused chat back as a draft beside one New chat opened meanwhile; New chat keeps the shown one, else takes the refused one", () => {
    // Arrange
    const refused = newSession('/p');
    startSession(refused, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    const opened = newSession('/p');
    $activeSessionId.set(refused);

    // Act
    revertToDraft(refused);
    const whileShown = newSession('/p');
    $activeSessionId.set(null);
    const withNoneShown = newSession('/p');
    $activeSessionId.set(null);
    showWorkspace('/p', 'main', '/p');

    // Assert
    expect(Object.keys($draftSessions.get()).sort(), 'both drafts kept').to.deep.equal([refused, opened].sort());
    expect(whileShown, 'the shown draft stays').to.equal(refused);
    expect([withNoneShown, $activeSessionId.get()], 'the refused one, holding the text').to.deep.equal([refused, refused]);
  });

  it('starts a session active as of its creation', () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    const [session] = $sessions.get();
    expect(session.lastActivityAt).to.equal(session.createdAt);
    expect([session.titleSource, session.agentTitle]).to.deep.equal(['prompt', null]);
  });

  it("stamps a session with the backend's time, keeping the later of two that arrive out of order", () => {
    const id = newSession('/p');
    startSession(id, { title: 'T', agentId: 'a', config: {}, mode: 'local' });
    touchSession(id, '2099-01-01T00:00:00.000Z');
    expect($sessions.get()[0].lastActivityAt).to.equal('2099-01-01T00:00:00.000Z');
    touchSession(id, '2098-12-31T23:59:59.999Z');
    expect($sessions.get()[0].lastActivityAt, 'an earlier stamp').to.equal('2099-01-01T00:00:00.000Z');
    // Later as a time though smaller as a string.
    touchSession(id, '2099-01-01T03:00:00.000+02:00');
    expect($sessions.get()[0].lastActivityAt).to.equal('2099-01-01T03:00:00.000+02:00');
    touchSession(id, 'not a time');
    expect($sessions.get()[0].lastActivityAt).to.equal('2099-01-01T03:00:00.000+02:00');
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
