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

  it('shows nothing without a branch to sync', () => {
    expect(git.remoteChip(null, NOW), 'outside a repository').to.equal(null);
    expect(git.remoteChip(repo({ branch: null, detached: true, upstream: null }), NOW), 'detached').to.equal(null);
  });
});
