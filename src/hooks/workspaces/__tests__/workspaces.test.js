import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $project } from '../../../stores/project/project.js';
import { $activeRoot, $activeWorkspaceId, $shownFolder, $workspaces, setActiveWorkspace } from '../../../stores/workspaces/workspaces.js';
import { $sessions, selectSession } from '../../../stores/sessions/sessions.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $activePath, $folderTabs, closeAllTabs } from '../../../stores/editor/editor.js';
import { $folderTerminalPanelHeights, $folderTerminalTabs, $terminals, openTerminal } from '../../../stores/terminals/terminals.js';
import { $folderExpandedFolders } from '../../../stores/file-tree/file-tree.js';
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

  it('says in a snackbar what changed in the shown project’s list, not what it had when shown', async () => {
    // Arrange: a second workspace appears with the next change
    let lists = 0;
    mockIPC(
      (cmd, args) => {
        if (cmd !== 'workspaces_list') return null;
        const { projectPath } = /** @type {{ projectPath: string }} */ (args);
        lists++;
        const task = { id: 'w1', projectPath, name: 'Fix login', branch: 'brama/fix-login', nameSource: 'user' };
        return lists === 1 ? [task] : [task, { ...task, id: 'w2', name: 'Add search', branch: 'brama/add-search' }];
      },
      { shouldMockEvents: true },
    );
    $notices.set([]);
    stop = workspaces.start();
    $project.set({ path: '/work/a', name: 'a', rootId: null });
    await until(() => $workspaces.get().length === 1);
    const shown = $notices.get().map((n) => n.message);

    // Act
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await until(() => $workspaces.get().length === 2);

    // Assert
    expect(shown, 'the list as shown').to.deep.equal([]);
    expect($notices.get().map((n) => [n.level, n.message])).to.deep.equal([['info', 'Created workspace "Add search" on brama/add-search']]);
    $notices.set([]);
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

  it('keeps a just created workspace listed when a list asked before it was made lands after', async () => {
    // Arrange: a change's list is still out when the create answers
    let lists = 0;
    /** @type {(list: unknown) => void} */
    let answerLate = () => {};
    clearMocks();
    mockIPC(
      (cmd) => {
        if (cmd === 'workspace_create') return { id: 'new', projectPath: '/work/a', name: 'Workspace 2' };
        if (cmd !== 'workspaces_list') return null;
        lists++;
        return lists === 1 ? [] : new Promise((resolve) => (answerLate = resolve));
      },
      { shouldMockEvents: true },
    );
    stop = workspaces.start();
    $project.set({ path: '/work/a', name: 'a', rootId: null });
    await until(() => lists === 1);
    await emit('workspaces://changed', { projectPath: '/work/a' });
    await until(() => lists === 2);

    // Act
    await workspaces.create('/work/a', 'main');
    answerLate([]);
    await new Promise((r) => setTimeout(r, 20));

    // Assert
    expect($workspaces.get().map((w) => w.id)).to.deep.equal(['new']);
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

  it('opens no folder for a workspace whose checkout failed, however often its list changes', async () => {
    // Arrange
    clearMocks();
    /** @type {string[]} */
    const opens = [];
    mockIPC(
      (cmd) => {
        if (cmd === 'workspaces_list') return [{ id: 'w8', projectPath: '/work/b', name: 'Task', folder: '/wt/eight', creating: false, missing: false, error: 'checkout failed' }];
        if (cmd !== 'open_workspace_root') return null;
        opens.push(cmd);
        throw new Error("/wt/eight: the workspace isn't checked out");
      },
      { shouldMockEvents: true },
    );
    $notices.set([]);
    stop = workspaces.start();
    $project.set({ path: '/work/b', name: 'b', rootId: 'r-b' });
    await until(() => $workspaces.get().length === 1);
    $sessions.set(/** @type {import('../../sessions/types.js').Session[]} */ (/** @type {unknown} */ ([{ id: 'c8', projectId: '/work/b', workspaceId: 'w8' }])));

    // Act
    selectSession('c8');
    await emit('workspaces://changed', { projectPath: '/work/b' });
    await emit('workspaces://changed', { projectPath: '/work/b' });
    await new Promise((r) => setTimeout(r, 50));

    // Assert
    expect($activeWorkspaceId.get(), 'shown').to.equal('w8');
    expect(opens, 'never opened').to.deep.equal([]);
    expect($notices.get(), 'no snackbar').to.deep.equal([]);
    expect($activeRoot.get()).to.deep.equal({ path: '/wt/eight', rootId: null, opening: false });
    selectSession(null);
    $sessions.set([]);
  });

  it("shows Main when the project's workspaces can't be listed, rather than waiting for its stored one", async () => {
    // Arrange
    mockIPC((cmd) => {
      if (cmd === 'workspaces_list') throw new Error('store unreadable');
      return null;
    });
    setActiveWorkspace('/work/a', 'w1');
    stop = workspaces.start();

    // Act
    $project.set({ path: '/work/a', name: 'a', rootId: 'root-a' });
    await until(() => $activeWorkspaceId.get() === 'main');

    // Assert
    expect($activeWorkspaceId.get()).to.equal('main');
    expect($activeRoot.get().path, "Main's folder").to.equal('/work/a');
    setActiveWorkspace('/work/a', 'main');
  });

  it("closes a workspace's shells before deleting it, and forgets its tabs, expanded folders and last chat once deleted", async () => {
    for (const fails of [true, false]) {
      // Arrange
      /** @type {string[]} */
      const order = [];
      clearMocks();
      mockIPC(
        (cmd, args) => {
          if (cmd === 'workspaces_list') return [{ id: 'w1', projectPath: '/work/a', name: 'Task', folder: '/wt/one', creating: false, missing: false }];
          if (cmd === 'open_workspace_root') return new Promise(() => {});
          if (cmd === 'terminal_close') order.push(`close ${/** @type {{ ids: string[] }} */ (args).ids}`);
          if (cmd === 'workspace_delete') order.push('delete');
          if (cmd === 'workspace_delete' && fails) throw new Error('git failed');
          return null;
        },
        { shouldMockEvents: true },
      );
      stop = workspaces.start();
      $project.set({ path: '/work/a', name: 'a', rootId: 'r-a' });
      await until(() => $workspaces.get().length === 1);
      $sessions.set(/** @type {import('../../sessions/types.js').Session[]} */ (/** @type {unknown} */ ([{ id: 'ws-chat', projectId: '/work/a', workspaceId: 'w1', folder: '/wt/one' }])));
      selectSession('ws-chat');
      await until(() => $shownFolder.get() === '/wt/one');
      const terminal = openTerminal('/wt/one', '/work/a', 'one');
      $folderTerminalPanelHeights.setKey('/wt/one', 300);
      $folderTabs.setKey('/wt/one', { paths: ['/wt/one/a.js'], active: '/wt/one/a.js', pinned: [] });
      $folderExpandedFolders.setKey('/wt/one', ['src']);
      const kept = () => [
        $folderTabs.get()['/wt/one'] !== undefined,
        $folderExpandedFolders.get()['/wt/one'] !== undefined,
        localStorage.getItem('brama:sessions:last:/wt/one') !== null,
      ];

      // Act
      await workspaces.delete('w1', true);

      // Assert
      expect(order, 'its shells are gone before its folder goes').to.deep.equal([`close ${terminal}`, 'delete']);
      expect([$terminals.get()[terminal], $folderTerminalTabs.get()['/wt/one'], $folderTerminalPanelHeights.get()['/wt/one']]).to.deep.equal([undefined, undefined, undefined]);
      expect(kept(), fails ? 'a failed delete forgets nothing else' : 'all forgotten').to.deep.equal(Array(3).fill(fails));

      // Cleanup
      stop();
      stop = null;
      selectSession(null);
      $sessions.set([]);
    }
  });

  it('opens the Changes tab of a workspace that has no chat yet', () => {
    // Arrange
    $sessions.set([]);

    // Act
    workspaces.changes('w1');

    // Assert
    expect($activePath.get()).to.equal('view:workspace-changes:w1');

    // Cleanup
    closeAllTabs();
  });

  it('says what applying a workspace to Main did, and what checking out its branch did', async () => {
    // Arrange
    $workspaces.set([/** @type {import('../types.js').Workspace} */ (/** @type {unknown} */ ({ id: 'w1', name: 'Fix tabs', branch: 'brama/fix-1' }))]);
    /** @type {(cmd: string) => unknown} */
    let answer = () => null;
    clearMocks();
    mockIPC((cmd) => {
      const value = answer(cmd);
      if (value instanceof Error) throw value;
      return value;
    });
    /** @type {[unknown, string, string][]} */
    const cases = [
      [{ outcome: 'clean', conflicts: [] }, 'info', 'Applied "Fix tabs" to Main, unstaged'],
      [{ outcome: 'empty', conflicts: [] }, 'info', '"Fix tabs" has no changes to apply'],
      [{ outcome: 'conflicts', conflicts: ['a.js', 'b.js'] }, 'warn', 'Applied "Fix tabs" with conflicts in a.js, b.js'],
    ];
    for (const [result, level, message] of cases) {
      $notices.set([]);
      answer = (cmd) => (cmd === 'workspace_apply_locally' ? result : null);
      // Act
      await workspaces.apply('w1');
      // Assert
      expect([$notices.get()[0]?.level, $notices.get()[0]?.message], message).to.deep.equal([level, message]);
    }
    // Act
    $notices.set([]);
    await workspaces.checkOut('w1');
    // Assert
    expect($notices.get()[0]?.message).to.equal('Checked out brama/fix-1 in Main');
    // Act
    $notices.set([]);
    answer = (cmd) => (cmd === 'workspace_check_out_branch' ? new Error('dirty worktree') : null);
    await workspaces.checkOut('w1');
    // Assert
    expect($notices.get()[0]?.level).to.equal('error');

    // Cleanup
    $workspaces.set([]);
    $notices.set([]);
  });
});
