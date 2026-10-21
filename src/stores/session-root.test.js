import { expect } from '@esm-bundle/chai';
import { $sessionRoot, $treeRoot, keepRecent, sessionRootAction, setSessionRoot } from './session-root.js';
import { $workspace } from './workspace.js';

/** @typedef {import('../models/types.js').Session} Session */

/**
 * @param {Partial<Session>} fields
 * @returns {Session}
 */
const session = (fields) =>
  /** @type {Session} */ ({
    id: 'w',
    mode: 'worktree',
    status: 'idle',
    folder: '/data/worktrees/app-1/fix-login-3f2a91bc',
    worktreePath: '/data/worktrees/app-1/fix-login-3f2a91bc',
    branch: 'brama/fix-login-3f2a91bc',
    ...fields,
  });

describe('session root', () => {
  afterEach(() => {
    setSessionRoot(null);
    $workspace.set(null);
  });

  it("is the project's folder, unlabeled, without a session root", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: 'root-1' });
    expect($treeRoot.get()).to.deep.equal({ rootId: 'root-1', path: '/p', label: null });
  });

  it("is the worktree's folder, labeled with its name, while one is open", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: 'root-1' });
    setSessionRoot({ sessionId: 'w', rootId: 'root-2', path: '/data/worktrees/app-1/fix-login-3f2a91bc/sub', label: 'fix-login-3f2a91bc' });
    expect($sessionRoot.get()?.sessionId).to.equal('w');
    expect($treeRoot.get()).to.deep.equal({ rootId: 'root-2', path: '/data/worktrees/app-1/fix-login-3f2a91bc/sub', label: 'fix-login-3f2a91bc' });
  });

  it('opens for a worktree session once it becomes active', () => {
    expect(sessionRootAction(session({}), null, false)).to.equal('open');
    expect(sessionRootAction(session({ id: 'other' }), session({}), true)).to.equal('open', 'another session');
    expect(sessionRootAction(session({ status: 'working' }), session({}), true)).to.equal('keep');
  });

  it('closes for a local session, a draft or no session', () => {
    expect(sessionRootAction(session({ mode: 'local', worktreePath: null, branch: null }), session({}), true)).to.equal('close');
    expect(sessionRootAction(null, session({}), true)).to.equal('close');
  });

  it('tries again once a start that was checking the worktree out is done', () => {
    const preparing = session({ status: 'preparing' });
    expect(sessionRootAction(preparing, null, false)).to.equal('open', 'a later start: the worktree may be there');
    expect(sessionRootAction(session({ status: 'starting' }), preparing, false)).to.equal('open');
    expect(sessionRootAction(session({ status: 'starting' }), preparing, true)).to.equal('keep', 'already open');
    expect(sessionRootAction(session({ status: 'idle' }), session({ status: 'starting' }), false)).to.equal('keep');
  });

  it('keeps the most recently shown roots, closing the oldest beyond the limit', () => {
    expect(keepRecent([], 'a', 2)).to.deep.equal({ order: ['a'], evicted: [] });
    expect(keepRecent(['a', 'b'], 'a', 2)).to.deep.equal({ order: ['b', 'a'], evicted: [] }, 'shown again: newest');
    expect(keepRecent(['a', 'b'], 'c', 2)).to.deep.equal({ order: ['b', 'c'], evicted: ['a'] });
  });
});
