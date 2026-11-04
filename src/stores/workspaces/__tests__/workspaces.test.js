import { expect } from '@esm-bundle/chai';
import { $openRoots, $project } from '../../project/project.js';
import {
  $activeRoot,
  $activeWorkspace,
  $activeWorkspaceId,
  $rootId,
  $shownFolder,
  $workspaceOpening,
  $worktrees,
  setActiveWorkspace,
  setWorkspaces,
} from '../workspaces.js';

/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */

const WORKSPACE = /** @type {Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/task' });
const CREATING = /** @type {Workspace} */ ({ id: 'w2', projectPath: '/p', name: 'New', folder: '/wt/new', creating: true });

describe('workspaces store', () => {
  afterEach(() => {
    for (const path of ['/p', '/q']) setActiveWorkspace(path, 'main');
    setWorkspaces([]);
    $openRoots.set({});
    $workspaceOpening.set(null);
    $project.set(null);
  });

  it("lists each workspace's folder and branch, chats or none, so its files are known as its", () => {
    // Arrange / Act
    setWorkspaces([{ ...WORKSPACE, branch: 'brama/task' }], '/p');

    // Assert
    expect($worktrees.get()).to.deep.equal([{ projectId: '/p', folder: '/wt/task', branch: 'brama/task' }]);
  });

  it("shows each project's chosen workspace; Main when none was or it's gone, waiting while its list loads", () => {
    // Arrange
    $project.set({ path: '/p', name: 'p', rootId: 'root-1' });
    setWorkspaces([WORKSPACE], '/p');

    // Act
    const seen = [];
    seen.push($activeWorkspaceId.get());
    setActiveWorkspace('/p', 'w1');
    seen.push($activeWorkspace.get()?.id);
    setActiveWorkspace('/p', 'gone');
    seen.push($activeWorkspaceId.get());
    setActiveWorkspace('/p', 'w1');
    $project.set({ path: '/q', name: 'q', rootId: 'root-2' });
    seen.push($activeWorkspaceId.get());
    setActiveWorkspace('/q', 'w9');
    seen.push($activeWorkspaceId.get());
    $project.set({ path: '/p', name: 'p', rootId: 'root-1' });
    seen.push($activeWorkspaceId.get());

    // Assert
    expect(seen).to.deep.equal(['main', 'w1', 'main', 'main', 'w9', 'w1']);
  });

  it("is the folder the window shows: Main's root, the workspace's once open", () => {
    const cases = [
      // [workspace, opening, open roots, listed for, expected, why]
      ['main', null, {}, '/p', { path: '/p', rootId: 'root-1', opening: false }, 'Main: the project'],
      ['w1', '/wt/task', {}, '/p', { path: '/wt/task', rootId: null, opening: true }, 'its root scans'],
      ['w1', null, { '/wt/task': 'root-2' }, '/p', { path: '/wt/task', rootId: 'root-2', opening: false }, 'its root is open'],
      ['w1', null, {}, '/p', { path: '/wt/task', rootId: null, opening: false }, 'not open, not opening (a failed open)'],
      ['w1', null, {}, '/other', { path: null, rootId: null, opening: true }, 'its list loads'],
      ['w2', null, {}, '/p', { path: '/wt/new', rootId: null, opening: true }, 'its folder still checks out'],
    ];
    for (const [id, opening, open, listedFor, expected, why] of cases) {
      // Arrange
      $project.set({ path: '/p', name: 'p', rootId: 'root-1' });
      setWorkspaces(listedFor === '/p' ? [WORKSPACE, CREATING] : [], /** @type {string} */ (listedFor));
      $openRoots.set(/** @type {Record<string, string>} */ (open));
      $workspaceOpening.set(/** @type {string | null} */ (opening));

      // Act
      setActiveWorkspace('/p', /** @type {string} */ (id));

      // Assert
      expect($activeRoot.get(), /** @type {string} */ (why)).to.deep.equal(expected);
      expect($rootId.get(), /** @type {string} */ (why)).to.equal(/** @type {{ rootId: string | null }} */ (expected).rootId);
      expect($shownFolder.get(), `${why}: the key of its tabs and terminals`).to.equal(/** @type {{ path: string | null }} */ (expected).path);
    }
  });
});
