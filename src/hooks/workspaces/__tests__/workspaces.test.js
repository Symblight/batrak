import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $project } from '../../../stores/project/project.js';
import { $workspaces } from '../../../stores/workspaces/workspaces.js';
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
});
