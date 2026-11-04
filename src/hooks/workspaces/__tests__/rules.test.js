import { expect } from '@esm-bundle/chai';
import { folderOfWorkspace, nextWaiting, noticesOf, orderWorkspaces, statusOf, statusesOf } from '../rules.js';

/** @typedef {import('../types.js').Workspace} Workspace */
/** @typedef {import('../../sessions/types.js').Session} Session */

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

/** @param {Partial<Workspace>} extra */
const workspace = (extra) =>
  /** @type {Workspace} */ ({ id: 'w', name: 'Task', branch: 'brama/task', createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: null, creating: false, error: null, missing: false, ...extra });

/** @param {Partial<Session>} extra */
const chat = (extra) => /** @type {Session} */ ({ id: 's', status: 'stopped', lastActivityAt: '2026-11-01T00:00:00.000Z', ...extra });

describe('workspaces rules', () => {
  it("statusOf: the strongest of its chats' statuses, and its own create / missing state", () => {
    /** @type {[Workspace | null, Session[], { pending?: string[], unread?: string[] }, string, string][]} */
    const cases = [
      [workspace({}), [], {}, 'idle', 'no chats'],
      [workspace({}), [chat({ status: 'idle' })], { unread: ['s'] }, 'unread', 'an unread chat'],
      [workspace({}), [chat({ id: 'a', status: 'working' }), chat({ id: 'b' })], { unread: ['b'] }, 'working', 'working beats unread'],
      [workspace({}), [chat({ status: 'queued' })], {}, 'working', 'queued is working'],
      [workspace({}), [chat({ activeElsewhereUntil: '2026-11-03T12:01:00.000Z' })], {}, 'working', 'active in another app'],
      [workspace({ creating: true }), [], {}, 'working', 'its checkout runs'],
      [workspace({}), [chat({ id: 'a', status: 'error' }), chat({ id: 'b', status: 'working' })], {}, 'error', 'error beats working'],
      [workspace({ missing: true }), [], {}, 'error', 'folder missing'],
      [workspace({ error: 'checkout failed' }), [], {}, 'error', 'failed create'],
      [workspace({ missing: true }), [chat({ status: 'waiting' })], {}, 'waiting', 'waiting beats error'],
      [workspace({}), [chat({ status: 'idle' })], { pending: ['s'] }, 'waiting', 'a pending permission request'],
      [null, [chat({ status: 'working' })], {}, 'working', 'Main'],
    ];
    for (const [ws, chats, { pending = [], unread = [] }, expected, why] of cases) {
      // Act
      const status = statusOf(ws, chats, { pending: new Set(pending), unread: new Set(unread), now: NOW });

      // Assert
      expect(status, why).to.equal(expected);
    }
  });

  it('orderWorkspaces: waiting, working, unread, idle, then the latest activity first', () => {
    // Arrange
    const list = [
      workspace({ id: 'old-idle', createdAt: '2026-10-01T00:00:00.000Z' }),
      workspace({ id: 'new-idle', createdAt: '2026-10-02T00:00:00.000Z' }),
      workspace({ id: 'active-idle', createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt: '2026-11-02T00:00:00.000Z' }),
      workspace({ id: 'chatted-idle', createdAt: '2026-09-01T00:00:00.000Z' }),
      workspace({ id: 'unread' }),
      workspace({ id: 'error' }),
      workspace({ id: 'working' }),
      workspace({ id: 'waiting' }),
    ];
    /** @type {Record<string, import('../types.js').WorkspaceStatus>} */
    const statuses = { 'old-idle': 'idle', 'new-idle': 'idle', 'active-idle': 'idle', 'chatted-idle': 'idle', unread: 'unread', error: 'error', working: 'working', waiting: 'waiting' };
    const chats = [chat({ workspaceId: 'chatted-idle', lastActivityAt: '2026-11-03T00:00:00.000Z' })];

    // Act
    const ordered = orderWorkspaces(list, statuses, chats);

    // Assert
    expect(ordered.map((w) => w.id)).to.deep.equal(['waiting', 'error', 'working', 'unread', 'chatted-idle', 'active-idle', 'new-idle', 'old-idle']);
  });

  it("statusesOf: each workspace's and Main's status from the project's own chats", () => {
    // Arrange
    const list = [workspace({ id: 'w1' }), workspace({ id: 'w2' })];
    const chats = [
      chat({ id: 'a', projectId: '/p', status: 'working' }),
      chat({ id: 'b', projectId: '/p', workspaceId: 'w1', status: 'waiting' }),
      chat({ id: 'c', projectId: '/q', workspaceId: 'w2', status: 'error' }),
    ];

    // Act
    const statuses = statusesOf('/p', list, chats, { pending: new Set(), unread: new Set(), now: NOW });

    // Assert
    expect(statuses).to.deep.equal({ main: 'working', w1: 'waiting', w2: 'idle' });
  });

  it("nextWaiting: the first waiting workspace after the shown one in the picker's order (Main last), wrapping, never the shown one", () => {
    const order = ['w1', 'w2', 'w3', 'main'];
    const cases = [
      // [statuses, shown, next, why]
      [{ w1: 'waiting', w3: 'waiting' }, 'w1', 'w3', 'after the shown one'],
      [{ w1: 'waiting', w3: 'waiting' }, 'w3', 'w1', 'wraps around'],
      [{ main: 'waiting' }, 'w2', 'main', 'Main is last'],
      [{ w2: 'waiting' }, 'w2', null, 'only the shown one waits'],
      [{ w1: 'working', w2: 'unread', main: 'error' }, 'w3', null, 'none waits'],
      [{ w2: 'waiting' }, 'gone', 'w2', 'the shown one is not in the list'],
    ];
    for (const [statuses, shown, next, why] of cases) {
      // Act + Assert
      expect(nextWaiting(order, /** @type {Record<string, import('../types.js').WorkspaceStatus>} */ (statuses), /** @type {string} */ (shown)), /** @type {string} */ (why)).to.equal(next);
    }
  });
  it("folderOfWorkspace: Main's is the project, a listed workspace's its folder, one not listed (yet) none", () => {
    // Arrange
    const list = [workspace({ id: 'w1', folder: '/wt/one/app' })];
    const cases = [
      ['main', '/p'],
      ['w1', '/wt/one/app'],
      ['w2', null],
    ];
    for (const [id, folder] of cases) {
      // Act + Assert
      expect(folderOfWorkspace('/p', /** @type {string} */ (id), list), String(id)).to.equal(folder);
    }
  });

  it('noticesOf: what changed between two lists of a project, worth a snackbar', () => {
    const task = workspace({ id: 'w1', name: 'Fix login', branch: 'brama/fix-login', nameSource: 'user' });
    const cases = [
      // [before, after, notices, why]
      [[], [task], ['Created workspace "Fix login" on brama/fix-login'], 'a new one'],
      [[task], [], ['Deleted workspace "Fix login"'], 'one gone'],
      [[task], [{ ...task, name: 'Login form' }], ['Renamed workspace "Fix login" to "Login form"'], 'renamed by the user'],
      [[{ ...task, nameSource: 'agent' }], [{ ...task, nameSource: 'agent', name: 'Login form' }], [], 'its agent titled it'],
      [[{ ...task, missing: true }], [task], ['Recreated the folder of "Fix login"'], 'its folder back'],
      [[task], [{ ...task, lastActiveAt: '2026-11-03T00:00:00.000Z' }], [], 'nothing to say'],
    ];
    for (const [before, after, notices, why] of cases) {
      // Act + Assert
      expect(noticesOf(/** @type {Workspace[]} */ (before), /** @type {Workspace[]} */ (after)), /** @type {string} */ (why)).to.deep.equal(notices);
    }
  });
});
