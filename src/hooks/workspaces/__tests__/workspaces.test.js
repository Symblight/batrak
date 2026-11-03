import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $project } from '../../../stores/project/project.js';
import { $activeRoot, $workspaces } from '../../../stores/workspaces/workspaces.js';
import { $sessions, selectSession } from '../../../stores/sessions/sessions.js';
import { $notices } from '../../../stores/notices/notices.js';
import { workspaces } from '../workspaces.js';

/** @param {() => boolean} pred */
async function until(pred) {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('workspaces hook', () => {
  /** @type {string[]} */
  let asked;
  /** @type {(() => void) | null} */
  let stop = null;

  beforeEach(() => {
    asked = [];
    $project.set(null);
    mockIPC(
      (cmd, args) => {
        if (cmd !== 'workspaces_list') return null;
        const { projectPath } = /** @type {{ projectPath: string }} */ (args);
        asked.push(projectPath);
        return [{ id: `w${asked.length}`, projectPath, name: 'Task' }];
      },
      { shouldMockEvents: true },
    );
  });

  afterEach(() => {
    stop?.();
    clearMocks();
    $project.set(null);
  });

  it("follows the shown project's workspaces: on open and on each change of its own", async () => {
    // Arrange
    stop = workspaces.start();

    // Act
    $project.set({ path: '/work/a', name: 'a', rootId: null });
    await until(() => asked.length === 1);
    await emit('workspaces://changed', { projectPath: '/work/other' });
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await until(() => asked.length === 2);

    // Assert
    expect(asked, 'the open project, then its own change only').to.deep.equal(['/work/a', '/work/a']);
    expect($workspaces.get().map((w) => w.id)).to.deep.equal(['w2']);
  });

  it('keeps the latest list when an older reply arrives after it', async () => {
    // Arrange: the first list call answers only after the second
    /** @type {((list: unknown) => void)[]} */
    const pending = [];
    clearMocks();
    mockIPC(
      (cmd) => {
        if (cmd !== 'workspaces_list') return null;
        return new Promise((resolve) => pending.push(resolve));
      },
      { shouldMockEvents: true },
    );
    stop = workspaces.start();
    $project.set({ path: '/work/a', name: 'a', rootId: null });
    await until(() => pending.length === 1);
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await until(() => pending.length === 2);

    // Act
    pending[1]([{ id: 'w', projectPath: '/work/a', name: 'Task', creating: false }]);
    await until(() => $workspaces.get().length === 1);
    pending[0]([{ id: 'w', projectPath: '/work/a', name: 'Task', creating: true }]);
    await new Promise((r) => setTimeout(r, 20));

    // Assert
    expect($workspaces.get().map((w) => w.creating)).to.deep.equal([false]);
  });

  it("opens the shown chat's workspace as the root once, keeps it for coming back, and closes it once the workspace goes", async () => {
    // Arrange
    /** @type {unknown[]} */
    let listed = [{ id: 'w1', projectPath: '/work/a', name: 'Task', folder: '/wt/one', creating: false, missing: false }];
    /** @type {((opened: unknown) => void)[]} */
    const opening = [];
    /** @type {unknown[]} */
    const closed = [];
    clearMocks();
    mockIPC(
      (cmd, args) => {
        const a = /** @type {Record<string, unknown>} */ (args);
        // Fresh objects each time, as from the backend.
        if (cmd === 'workspaces_list') return structuredClone(listed);
        if (cmd === 'open_workspace_root') return new Promise((resolve) => opening.push(resolve));
        if (cmd === 'close_root') closed.push(a.rootId);
        return null;
      },
      { shouldMockEvents: true },
    );
    stop = workspaces.start();
    $project.set({ path: '/work/a', name: 'a', rootId: 'r-a' });
    await until(() => $workspaces.get().length === 1);
    $sessions.set(/** @type {import('../../sessions/types.js').Session[]} */ (/** @type {unknown} */ ([
      { id: 'main-chat', projectId: '/work/a', workspaceId: null },
      { id: 'ws-chat', projectId: '/work/a', workspaceId: 'w1' },
    ])));

    // Act: show the workspace's chat
    selectSession('ws-chat');
    await until(() => opening.length === 1);

    // Assert
    expect($activeRoot.get(), 'scanning').to.deep.equal({ path: '/wt/one', rootId: null, opening: true });

    // Act: the list refreshes while it scans, the scan ends; back to Main and to the workspace again
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await new Promise((r) => setTimeout(r, 20));
    opening[0]({ rootId: 'r-w1', path: '/wt/one' });
    await until(() => $activeRoot.get().rootId === 'r-w1');
    selectSession('main-chat');
    const main = $activeRoot.get();
    selectSession('ws-chat');
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await new Promise((r) => setTimeout(r, 20));

    // Assert
    expect(main).to.deep.equal({ path: '/work/a', rootId: 'r-a', opening: false });
    expect($activeRoot.get(), 'kept open: no second scan').to.deep.equal({ path: '/wt/one', rootId: 'r-w1', opening: false });
    expect(opening).to.have.length(1);

    // Act: the workspace is deleted
    listed = [];
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await until(() => closed.length === 1);

    // Assert
    expect(closed).to.deep.equal(['r-w1']);
    selectSession(null);
    $sessions.set([]);
  });

  it("says so when the shown workspace's folder can't be opened", async () => {
    // Arrange
    clearMocks();
    mockIPC(
      (cmd) => {
        if (cmd === 'workspaces_list') return [{ id: 'w9', projectPath: '/work/b', name: 'Task', folder: '/wt/nine', creating: false, missing: false }];
        if (cmd === 'open_workspace_root') throw new Error('/wt/nine: the workspace isn\'t checked out');
        return null;
      },
      { shouldMockEvents: true },
    );
    $notices.set([]);
    stop = workspaces.start();
    $project.set({ path: '/work/b', name: 'b', rootId: 'r-b' });
    await until(() => $workspaces.get().length === 1);
    $sessions.set(/** @type {import('../../sessions/types.js').Session[]} */ (/** @type {unknown} */ ([{ id: 'c9', projectId: '/work/b', workspaceId: 'w9' }])));

    // Act
    selectSession('c9');
    await until(() => $notices.get().length > 0);

    // Assert
    expect($notices.get().map((n) => n.message).join()).to.include("isn't checked out");
    expect($activeRoot.get()).to.deep.equal({ path: '/wt/nine', rootId: null, opening: false });
    selectSession(null);
    $sessions.set([]);
    $notices.set([]);
  });
});
