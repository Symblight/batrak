import { expect } from '@esm-bundle/chai';
import { $openRoots, $project } from '../../project/project.js';
import { $sessions, selectSession } from '../../sessions/sessions.js';
import { $activeRoot, $rootId, $workspaceOpening, $workspaces } from '../workspaces.js';

/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */
/** @typedef {import('../../../hooks/sessions/types.js').Session} Session */

const WORKSPACE = /** @type {Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/task' });

/**
 * @param {string} id
 * @param {string | null} workspaceId
 */
function chat(id, workspaceId) {
  return /** @type {Session} */ (/** @type {unknown} */ ({ id, projectId: '/p', workspaceId, status: 'idle' }));
}

describe('$activeRoot', () => {
  afterEach(() => {
    selectSession(null);
    $sessions.set([]);
    $workspaces.set([]);
    $openRoots.set({});
    $workspaceOpening.set(null);
    $project.set(null);
  });

  it("is the project's root in Main and the shown chat's workspace's once its root is open", () => {
    const cases = [
      // [shown chat, opening, open roots, expected, why]
      ['main', null, {}, { path: '/p', rootId: 'root-1', opening: false }, 'Main: the project'],
      ['ws', '/wt/task', {}, { path: '/wt/task', rootId: null, opening: true }, 'its root scans'],
      ['ws', null, { '/wt/task': 'root-2' }, { path: '/wt/task', rootId: 'root-2', opening: false }, 'its root is open'],
      ['ws', null, {}, { path: '/wt/task', rootId: null, opening: false }, 'not open, not opening (a failed open)'],
    ];
    for (const [shown, opening, open, expected, why] of cases) {
      // Arrange
      $project.set({ path: '/p', name: 'p', rootId: 'root-1' });
      $workspaces.set([WORKSPACE]);
      $sessions.set([chat('main', null), chat('ws', 'w1')]);
      $openRoots.set(/** @type {Record<string, string>} */ (open));
      $workspaceOpening.set(/** @type {string | null} */ (opening));

      // Act
      selectSession(/** @type {string} */ (shown));

      // Assert
      expect($activeRoot.get(), /** @type {string} */ (why)).to.deep.equal(expected);
      expect($rootId.get(), /** @type {string} */ (why)).to.equal(/** @type {{ rootId: string | null }} */ (expected).rootId);
    }
  });
});
