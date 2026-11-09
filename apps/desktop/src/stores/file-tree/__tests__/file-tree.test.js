import { expect } from '@esm-bundle/chai';
import { $expandedFolders, $fileMarks, $folderExpandedFolders, fileMarks, removeFolderExpandedFolders, setExpandedFolders } from '../file-tree.js';
import { $gitChanges, NO_CHANGES } from '../../git/git.js';
import { $sessions } from '../../sessions/sessions.js';
import { setActiveWorkspace, setWorkspaces } from '../../workspaces/workspaces.js';
import { $project } from '../../project/project.js';

const WORKTREE = '/data/worktrees/app-1/fix-login-3f2a91bc';

describe('file tree expanded folders', () => {
  /** @param {string | null} id Shows the workspace of that chat: `ws` runs in the workspace, `main` (or none) in Main. */
  const show = (id) => setActiveWorkspace('/p', id === 'ws' ? 'w' : 'main');

  beforeEach(() => {
    setWorkspaces([/** @type {import('../../../hooks/workspaces/types.js').Workspace} */ ({ id: 'w', projectPath: '/p', name: 'Fix login', folder: WORKTREE })], '/p');
    $sessions.set(/** @type {import('../../../hooks/sessions/types.js').Session[]} */ (/** @type {unknown} */ ([
      { id: 'main', projectId: '/p', workspaceId: null },
      { id: 'ws', projectId: '/p', workspaceId: 'w' },
    ])));
  });

  afterEach(() => {
    show(null);
    $sessions.set([]);
    setWorkspaces([]);
    removeFolderExpandedFolders('/p');
    removeFolderExpandedFolders(WORKTREE);
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
    expect($folderExpandedFolders.get()['/p']).to.deep.equal(['src', 'node_modules']);
    setExpandedFolders([]);
    expect($expandedFolders.get()).to.deep.equal([], 'all collapsed stays collapsed');

    show('main');
    expect($expandedFolders.get()).to.deep.equal(['src', 'node_modules']);
  });
});

/** @typedef {import('../../../hooks/git/types.js').GitFileStatus} GitFileStatus */

/**
 * @param {GitFileStatus['kind']} kind
 * @param {string} path
 * @param {string | null} [origPath]
 * @returns {GitFileStatus}
 */
const change = (kind, path, origPath = null) => ({ path, kind, staged: false, unstaged: true, origPath, added: null, removed: null });

describe('file tree git marks', () => {
  afterEach(() => $gitChanges.set(NO_CHANGES));

  it('marks each changed file by its kind and every folder above it', () => {
    const marks = fileMarks([
      change('modified', 'README.md'),
      change('added', 'src/new.js'),
      change('untracked', 'src/ui/draft.js'),
      change('typeChanged', 'link'),
      change('conflicted', 'Cargo.toml'),
      change('renamed', 'lib/new-name.js', 'lib/old-name.js'),
      change('deleted', 'gone/old.js'),
    ]);

    expect(Object.fromEntries(marks)).to.deep.equal({
      'README.md': { kind: 'modified', folder: false },
      'src/new.js': { kind: 'added', folder: false },
      'src/ui/draft.js': { kind: 'untracked', folder: false },
      src: { kind: 'added', folder: true },
      'src/ui': { kind: 'untracked', folder: true },
      link: { kind: 'typeChanged', folder: false },
      'Cargo.toml': { kind: 'conflicted', folder: false },
      'lib/new-name.js': { kind: 'renamed', folder: false },
      lib: { kind: 'renamed', folder: true },
      gone: { kind: 'deleted', folder: true },
    }, 'a renamed file at its new path only; a deleted one by its folders only');
  });

  it('gives a folder the most serious kind under it', () => {
    const marks = fileMarks([
      change('untracked', 'a/1'),
      change('modified', 'a/2'),
      change('added', 'a/b/3'),
      change('deleted', 'a/b/4'),
      change('conflicted', 'a/c/5'),
      change('modified', 'a/c/6'),
    ]);

    expect([marks.get('a')?.kind, marks.get('a/b')?.kind, marks.get('a/c')?.kind]).to.deep.equal(['conflicted', 'deleted', 'conflicted']);
  });

  it('marks the loaded changes only, the same map while the files are the same', () => {
    const files = [change('modified', 'a.js')];
    $gitChanges.set({ files, loaded: false, loading: true, error: null });
    expect($fileMarks.get().size).to.equal(0, 'before the status loads');
    $gitChanges.set({ files, loaded: true, loading: false, error: 'git not found' });
    expect($fileMarks.get().size).to.equal(0, 'on an error');

    $gitChanges.set({ files, loaded: true, loading: false, error: null });
    const marks = $fileMarks.get();
    $gitChanges.set({ files, loaded: true, loading: true, error: null });

    expect(marks.get('a.js')).to.deep.equal({ kind: 'modified', folder: false });
    expect($fileMarks.get()).to.equal(marks);
  });
});
