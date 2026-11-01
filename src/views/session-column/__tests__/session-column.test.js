import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projects } from '../../../stores/projects/projects.js';
import { $sessionReads, $unreadSessions } from '../../../stores/session-read/session-read.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import '../session-column.js';

/** @typedef {import('../session-column.js').AcpSessionColumn} AcpSessionColumn */
/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */

const SEEN = { seen: '2026-01-01T00:00:00.000Z' };

/**
 * @param {string} id
 * @param {string} projectId
 * @returns {Session}
 */
function session(id, projectId) {
  return {
    id,
    projectId,
    title: id,
    status: 'idle',
    agentId: 'a',
    config: {},
    mode: 'local',
    folder: projectId,
    worktreePath: null,
    branch: null,
    baseCommit: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
  };
}

describe('acp-session-column', () => {
  const ids = ['a', 'b', 'c'];

  beforeEach(() => {
    mockIPC(() => null);
    $projects.set([
      { id: '/p', name: 'p', path: '/p' },
      { id: '/q', name: 'q', path: '/q' },
    ]);
    $sessions.set([session('a', '/p'), session('b', '/p'), session('c', '/q')]);
    for (const id of ids) $sessionReads.setKey(id, SEEN);
  });

  afterEach(() => {
    $sessions.set([]);
    $projects.set([]);
    for (const id of ids) $sessionReads.setKey(id, undefined);
    clearMocks();
  });

  it('marks a session read or unread, and a whole project read, as its list asks', async () => {
    // Arrange
    const el = /** @type {AcpSessionColumn} */ (await fixture(html`<acp-session-column></acp-session-column>`));
    const list = /** @type {HTMLElementTagNameMap['acp-session-list']} */ (el.querySelector('acp-session-list'));
    /** @param {string} type @param {object} detail */
    const ask = (type, detail) => list.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    expect($unreadSessions.get(), 'all unread').to.have.members(ids);

    // Act + Assert
    ask('acp-session-mark-read', { sessionId: 'a', read: true });
    expect($unreadSessions.get(), 'a read').to.have.members(['b', 'c']);
    ask('acp-session-mark-read', { sessionId: 'a', read: false });
    expect($unreadSessions.get(), 'a unread again').to.have.members(ids);
    ask('acp-project-mark-read', { projectId: '/p' });
    expect($unreadSessions.get(), 'the project’s read').to.deep.equal(['c']);
  });
});
