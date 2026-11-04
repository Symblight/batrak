import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $project } from '../../../stores/project/project.js';
import { $sessionReads, $unreadSessions } from '../../../stores/session-read/session-read.js';
import { $activeSessionId, $draftSessions, $sessions } from '../../../stores/sessions/sessions.js';
import { $activeSubagent, $subagents, showSubagent } from '../../../stores/session-runtime/session-runtime.js';
import { setActiveWorkspace, setWorkspaces } from '../../../stores/workspaces/workspaces.js';
import '../session-column.js';

/** @typedef {import('../session-column.js').AcpSessionColumn} AcpSessionColumn */
/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */
/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */

const SEEN = { seen: '2026-01-01T00:00:00.000Z' };
const TASK = /** @type {Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Fix login', folder: '/wt/w1', creating: false, missing: false, error: null });

/**
 * @param {string} id
 * @param {string} projectId
 * @param {string | null} [workspaceId]
 * @returns {Session}
 */
function session(id, projectId, workspaceId = null) {
  return {
    id,
    projectId,
    workspaceId,
    title: id,
    status: 'idle',
    agentId: 'a',
    config: {},
    folder: workspaceId ? '/wt/w1' : projectId,
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
  };
}

/** @param {AcpSessionColumn} el */
const listed = (el) => (el.querySelector('acp-session-list')?.sessions ?? []).map((s) => s.id);

describe('acp-session-column', () => {
  const ids = ['a', 'b', 'c', 'q'];

  beforeEach(() => {
    mockIPC(() => null);
    $project.set({ path: '/p', name: 'p', rootId: null });
    setWorkspaces([TASK], '/p');
    $sessions.set([session('a', '/p'), session('b', '/p', 'w1'), session('c', '/p', 'w1'), session('q', '/q')]);
    for (const id of ids) $sessionReads.setKey(id, SEEN);
  });

  afterEach(() => {
    setActiveWorkspace('/p', 'main');
    setWorkspaces([]);
    $activeSessionId.set(null);
    $draftSessions.set({});
    $sessions.set([]);
    $project.set(null);
    for (const id of ids) $sessionReads.setKey(id, undefined);
    clearMocks();
  });

  it("lists only the shown workspace's chats under its name, and swaps them on a switch", async () => {
    // Arrange
    const el = /** @type {AcpSessionColumn} */ (await fixture(html`<acp-session-column></acp-session-column>`));
    const header = /** @type {HTMLElementTagNameMap['acp-workspace-header']} */ (el.querySelector('acp-workspace-header'));
    const main = listed(el);
    const mainName = header.workspace;

    // Act
    setActiveWorkspace('/p', 'w1');
    await el.updateComplete;

    // Assert
    expect([main, mainName], 'Main').to.deep.equal([['a'], null]);
    expect([listed(el), header.workspace?.name], 'the workspace').to.deep.equal([['b', 'c'], 'Fix login']);
    expect(el.querySelector('acp-project-row'), 'no project rows').to.equal(null);
  });

  it("starts a new chat in the shown workspace from its header", async () => {
    // Arrange
    setActiveWorkspace('/p', 'w1');
    const el = /** @type {AcpSessionColumn} */ (await fixture(html`<acp-session-column></acp-session-column>`));

    // Act
    el.querySelector('acp-workspace-header')?.dispatchEvent(new CustomEvent('acp-workspace-new-chat', { detail: null, bubbles: true, composed: true }));

    // Assert
    const active = /** @type {string} */ ($activeSessionId.get());
    expect($draftSessions.get()[active]).to.deep.equal({ projectId: '/p', workspaceId: 'w1' });
  });

  it('tells the header which other workspaces wait, and goes to the waiting chat from its strip', async () => {
    // Arrange: a chat of the workspace waits while Main is shown
    $sessions.set($sessions.get().map((s) => (s.id === 'c' ? { ...s, status: 'waiting' } : s)));
    const el = /** @type {AcpSessionColumn} */ (await fixture(html`<acp-session-column></acp-session-column>`));
    const header = /** @type {HTMLElementTagNameMap['acp-workspace-header']} */ (el.querySelector('acp-workspace-header'));
    const waiting = header.waiting;

    // Act
    header.dispatchEvent(new CustomEvent('acp-workspace-next-waiting', { detail: null, bubbles: true, composed: true }));
    await el.updateComplete;

    // Assert
    expect(waiting, 'from Main').to.deep.equal(['Fix login']);
    expect([$activeSessionId.get(), listed(el)], 'its waiting chat').to.deep.equal(['c', ['b', 'c']]);
    expect(header.waiting, 'none waits elsewhere').to.deep.equal([]);
  });

  it('marks a chat read or unread as its list asks', async () => {
    // Arrange
    const el = /** @type {AcpSessionColumn} */ (await fixture(html`<acp-session-column></acp-session-column>`));
    const list = /** @type {HTMLElementTagNameMap['acp-session-list']} */ (el.querySelector('acp-session-list'));
    /** @param {string} type @param {object} detail */
    const ask = (type, detail) => list.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

    // Act + Assert
    ask('acp-session-mark-read', { sessionId: 'a', read: true });
    expect($unreadSessions.get(), 'a read').to.have.members(['b', 'c', 'q']);
    ask('acp-session-mark-read', { sessionId: 'a', read: false });
    expect($unreadSessions.get(), 'a unread again').to.have.members(ids);
  });

  it("hands the list each chat's subagents; one picked there is shown, its chat's row goes back to the chat", async () => {
    // Arrange
    /** @type {import('../../../hooks/sessions/types.js').Subagent} */
    const sub = { id: 'c1', title: 'Find usages', description: 'Explore', state: 'running', stopReason: null, cancellable: true, announcedAt: '2026-01-01T00:00:00.000Z' };
    $subagents.set({ a: [sub] });
    const el = /** @type {AcpSessionColumn} */ (await fixture(html`<acp-session-column></acp-session-column>`));
    const list = /** @type {HTMLElementTagNameMap['acp-session-list']} */ (el.querySelector('acp-session-list'));
    /** @param {string} type @param {object} detail */
    const ask = (type, detail) => list.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    try {
      // Act
      ask('acp-subagent-open', { sessionId: 'a', subagentId: 'c1' });
      await el.updateComplete;
      // Assert
      expect(list.subagents).to.deep.equal({ a: [sub] });
      expect($activeSessionId.get()).to.equal('a');
      expect($activeSubagent.get()).to.deep.equal(sub);
      expect(list.activeSubagentId).to.equal('c1');
      // Act
      ask('acp-session-select', { sessionId: 'a' });
      // Assert
      expect($activeSubagent.get(), 'back to the chat').to.equal(null);
    } finally {
      showSubagent(null);
      $subagents.set({});
    }
  });


});
