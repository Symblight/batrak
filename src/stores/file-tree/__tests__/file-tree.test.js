import { expect } from '@esm-bundle/chai';
import { $expandedFolders, $projectExpandedFolders, removeProjectExpandedFolders, setExpandedFolders } from '../file-tree.js';
import { $sessions, selectSession } from '../../sessions/sessions.js';
import { $workspaces } from '../../workspaces/workspaces.js';
import { $project } from '../../project/project.js';

const WORKTREE = '/data/worktrees/app-1/fix-login-3f2a91bc';

describe('file tree expanded folders', () => {
  /** @param {string | null} id Shows that chat: `ws` runs in the workspace, `main` in Main. */
  const show = (id) => selectSession(id);

  beforeEach(() => {
    $workspaces.set([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w', projectPath: '/p', name: 'Fix login', folder: WORKTREE })]);
    $sessions.set(/** @type {import('../../../hooks/sessions/types.js').Session[]} */ (/** @type {unknown} */ ([
      { id: 'main', projectId: '/p', workspaceId: null },
      { id: 'ws', projectId: '/p', workspaceId: 'w' },
    ])));
  });

  afterEach(() => {
    show(null);
    $sessions.set([]);
    $workspaces.set([]);
    removeProjectExpandedFolders('/p');
    removeProjectExpandedFolders(WORKTREE);
    $project.set(null);
  });

  it("keeps a workspace's apart from the project's, starting from the project's", () => {
    $project.set({ path: '/p', name: 'p', rootId: 'root-1' });
    setExpandedFolders(['src', 'node_modules']);

    show('ws');
    expect($expandedFolders.get()).to.deep.equal(['src', 'node_modules'], "the project's until it has its own");
    // The workspace has no node_modules: the tree forgets it there only.
    setExpandedFolders(['src']);
    expect($expandedFolders.get()).to.deep.equal(['src']);
    expect($projectExpandedFolders.get()['/p']).to.deep.equal(['src', 'node_modules']);
    setExpandedFolders([]);
    expect($expandedFolders.get()).to.deep.equal([], 'all collapsed stays collapsed');

    show('main');
    expect($expandedFolders.get()).to.deep.equal(['src', 'node_modules']);
  });
});
