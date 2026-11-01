import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $sessionRoot } from '../../../stores/session-root/session-root.js';
import { $activeSessionId, $sessions } from '../../../stores/sessions/sessions.js';

/** @typedef {import('../../../models/types/types.js').Session} Session */

let counter = 0;

/**
 * A fresh copy of the part: its open roots and the active session it follows are module-level.
 * @returns {Promise<typeof import('../root.js').root>}
 */
async function fresh() {
  return (await import(`../root.js?fresh=${++counter}`)).root;
}

/** @param {string} id */
function worktree(id) {
  return /** @type {Session} */ ({ id, projectId: '/p', title: id, mode: 'worktree', worktreePath: `/wt/${id}`, status: 'idle', lastActivityAt: '' });
}

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done(), 'timed out').to.equal(true);
}

describe('sessions root', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC(
      (cmd, args) => {
        const a = /** @type {Record<string, unknown>} */ (args ?? {});
        calls.push({ cmd, args: a });
        if (cmd === 'open_session_root') return { rootId: `root:${a.sessionId}`, path: `/wt/${a.sessionId}`, entries: [] };
        return null;
      },
      { shouldMockEvents: true },
    );
  });

  afterEach(() => {
    $activeSessionId.set(null);
    $sessions.set([]);
    $sessionRoot.set(null);
    clearMocks();
  });

  it('opens the shown worktree session’s folder as the tree root and keeps the last three open', async () => {
    const root = await fresh();
    $sessions.set(['a', 'b', 'c', 'd'].map(worktree));
    root.start();
    for (const id of ['a', 'b', 'c', 'd']) {
      $activeSessionId.set(id);
      await until(() => $sessionRoot.get()?.sessionId === id);
    }
    expect($sessionRoot.get()).to.include({ rootId: 'root:d', path: '/wt/d', label: 'd' });
    await until(() => calls.some((c) => c.cmd === 'close_workspace'));
    expect(calls.filter((c) => c.cmd === 'close_workspace').map((c) => c.args), 'the oldest').to.deep.equal([{ rootId: 'root:a' }]);
    $activeSessionId.set(null);
    await until(() => $sessionRoot.get() === null);
    expect(calls.filter((c) => c.cmd === 'open_session_root').length, 'showing none opens nothing').to.equal(4);
  });

  it('hands the shown root’s file changes to whoever listens, until they stop', async () => {
    const root = await fresh();
    root.start();
    $sessionRoot.set({ sessionId: 's1', rootId: 'root:s1', path: '/wt/s1', label: 's1' });
    /** @type {unknown[]} */
    const heard = [];
    const stop = root.onFsChange((changes) => heard.push(changes));
    await new Promise((r) => setTimeout(r, 30));
    await emit('workspace://changed', { rootId: 'root:other', dirs: [] });
    await emit('workspace://changed', { rootId: 'root:s1', dirs: ['src'] });
    await until(() => heard.length === 1);
    stop();
    await emit('workspace://changed', { rootId: 'root:s1', dirs: ['src'] });
    await new Promise((r) => setTimeout(r, 30));
    expect(heard).to.deep.equal([{ rootId: 'root:s1', dirs: ['src'] }]);
  });
});
