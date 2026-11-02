import { expect } from '@esm-bundle/chai';
import { git } from '../git.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const MIN = 60_000;

/** @param {Partial<import('../types.js').GitRepoState>} [fields] @returns {import('../types.js').GitRepoState} */
const repo = (fields = {}) => ({
  branch: 'main',
  sha: 'abc1234',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  upstreamSha: null,
  remote: { name: 'origin', url: 'https://example.test/a/b.git', github: null },
  hasRemotes: true,
  fetchedAt: NOW - 3 * MIN,
  ...fields,
});

describe('git remote chip', () => {
  it('says what the branch needs next, and how it got there', () => {
    /** @type {[string, Partial<import('../types.js').GitRepoState>, Record<string, unknown>][]} */
    const cases = [
      ['in sync', {}, { id: 'synced', label: 'Synced', icon: 'check', tooltip: 'Up to date with origin/main · fetched 3 minutes ago' }],
      ['ahead', { ahead: 4 }, { id: 'push', label: 'Push 4', icon: 'arrow_upward', tooltip: '4 commits to push to origin/main · fetched 3 minutes ago' }],
      ['one ahead', { ahead: 1 }, { id: 'push', tooltip: '1 commit to push to origin/main · fetched 3 minutes ago' }],
      ['behind', { behind: 2 }, { id: 'pull', label: 'Pull 2', icon: 'arrow_downward', tooltip: '2 commits to pull from origin/main · fetched 3 minutes ago' }],
      ['diverged', { ahead: 4, behind: 2 }, { id: 'diverged', label: '↑4 | ↓2', icon: 'swap_vert', tooltip: 'Diverged from origin/main: 4 to push, 2 to pull · fetched 3 minutes ago' }],
      ['never fetched', { fetchedAt: null }, { id: 'synced', tooltip: 'Up to date with origin/main · not fetched yet' }],
      ['no upstream', { upstream: null }, { id: 'publish', label: 'Publish', icon: 'cloud_upload', tooltip: 'Branch main is not on origin yet' }],
      ['no remote', { upstream: null, remote: null, hasRemotes: false }, { id: 'none', label: 'No remote', icon: '', tooltip: 'Add a remote in a terminal: git remote add origin <url>' }],
    ];
    for (const [why, fields, expected] of cases) {
      // Act
      const chip = git.remoteChip(repo(fields), NOW);
      // Assert
      expect(chip, why).to.deep.include(expected);
    }
  });

  it('is a button only where one click does the obvious thing', () => {
    /** @type {[Partial<import('../types.js').GitRepoState>, string | null][]} */
    const cases = [
      [{}, 'fetch'],
      [{ ahead: 1 }, 'push'],
      [{ behind: 1 }, 'pull'],
      [{ ahead: 1, behind: 1 }, null],
      [{ upstream: null }, 'publish'],
      [{ upstream: null, remote: null, hasRemotes: false }, null],
    ];
    for (const [fields, action] of cases) {
      expect(git.remoteChip(repo(fields), NOW)?.action, JSON.stringify(fields)).to.equal(action);
    }
  });

  it('shows a running operation as busy and a failed one with its reason, over the branch state', () => {
    /** @type {[import('../types.js').GitRemoteAction, string, string][]} */
    const verbs = [
      ['fetch', 'Fetching…', 'Fetch failed'],
      ['pull', 'Pulling…', 'Pull failed'],
      ['pullRebase', 'Pulling…', 'Pull failed'],
      ['pullMerge', 'Pulling…', 'Pull failed'],
      ['forcePush', 'Pushing…', 'Force push failed'],
      ['abort', 'Aborting…', 'Abort failed'],
      ['push', 'Pushing…', 'Push failed'],
      ['publish', 'Publishing…', 'Publish failed'],
    ];
    for (const [action, busy, failed] of verbs) {
      const running = git.remoteChip(repo({ ahead: 4 }), NOW, { rootId: 'r', action, state: 'running', error: null });
      expect(running, action).to.deep.include({ id: 'busy', label: busy, action: null });
      const error = { kind: /** @type {const} */ ('rejected'), message: '! [rejected] main -> main (fetch first)\nerror: failed to push' };
      const broke = git.remoteChip(repo({ ahead: 4 }), NOW, { rootId: 'r', action, state: 'failed', error });
      expect(broke, action).to.deep.include({ id: 'failed', label: failed, icon: 'error', tooltip: '! [rejected] main -> main (fetch first)', action: null });
    }
  });

  it('asks before a pull changes the files of a folder an agent is working in', () => {
    const session = (/** @type {string} */ id, /** @type {string} */ status, folder = '/work/app') =>
      /** @type {import('../../sessions/types.js').Session} */ (/** @type {unknown} */ ({ id, title: `Session ${id}`, status, folder }));
    const sessions = [session('a', 'idle'), session('b', 'working', '/work/app-wt'), session('c', 'stopped'), session('d', 'waiting'), session('e', 'queued')];
    // Act
    const one = git.pullConfirm([sessions[0], sessions[1], sessions[3]], '/work/app');
    const two = git.pullConfirm(sessions, '/work/app');
    // Assert
    expect(git.pullConfirm(sessions.slice(0, 3), '/work/app'), 'idle, stopped or in a worktree: nothing to protect').to.equal(null);
    expect(one).to.deep.include({ headline: 'An agent is working here', confirmLabel: 'Pull anyway' });
    expect(one?.message).to.contain('Session d');
    expect(two?.message, 'several sessions are counted').to.contain('2 sessions');
  });

  it('shows nothing without a branch to sync', () => {
    expect(git.remoteChip(null, NOW), 'outside a repository').to.equal(null);
    expect(git.remoteChip(repo({ branch: null, detached: true, upstream: null }), NOW), 'detached').to.equal(null);
  });
});
