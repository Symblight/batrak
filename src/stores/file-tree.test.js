import { expect } from '@esm-bundle/chai';
import { $expandedFolders, $projectExpandedFolders, removeProjectExpandedFolders, setExpandedFolders } from './file-tree.js';
import { setSessionRoot } from './session-root.js';
import { $workspace } from './workspace.js';

const WORKTREE = '/data/worktrees/app-1/fix-login-3f2a91bc';

describe('file tree expanded folders', () => {
  afterEach(() => {
    setSessionRoot(null);
    removeProjectExpandedFolders('/p');
    removeProjectExpandedFolders(WORKTREE);
    $workspace.set(null);
  });

  it("keeps a worktree's apart from the project's, starting from the project's", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: 'root-1' });
    setExpandedFolders(['src', 'node_modules']);

    setSessionRoot({ sessionId: 'w', rootId: 'root-2', path: WORKTREE, label: 'fix-login-3f2a91bc' });
    expect($expandedFolders.get()).to.deep.equal(['src', 'node_modules'], "the project's until it has its own");
    // The worktree has no node_modules: the tree forgets it there only.
    setExpandedFolders(['src']);
    expect($expandedFolders.get()).to.deep.equal(['src']);
    expect($projectExpandedFolders.get()['/p']).to.deep.equal(['src', 'node_modules']);
    setExpandedFolders([]);
    expect($expandedFolders.get()).to.deep.equal([], 'all collapsed stays collapsed');

    setSessionRoot(null);
    expect($expandedFolders.get()).to.deep.equal(['src', 'node_modules']);
  });
});
