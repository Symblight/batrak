import { expect } from '@esm-bundle/chai';
import { git } from '../git.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** @param {string} name @param {Partial<import('../types.js').GitLocalBranch>} [fields] @returns {import('../types.js').GitLocalBranch} */
const local = (name, fields = {}) => ({ name, current: false, ahead: 0, behind: 0, committedAt: NOW - 2 * HOUR, ...fields });

/** @type {import('../types.js').GitBranchList} */
const LIST = {
  local: [
    local('feature/x', { committedAt: NOW - 5 * MIN }),
    local('main', { current: true, ahead: 2, behind: 1 }),
    local('brama/session-1', { committedAt: NOW - DAY }),
    local('old', { committedAt: NOW - 3 * DAY }),
  ],
  remote: [
    { remote: 'origin', name: 'feature/y' },
    { remote: 'origin', name: 'release' },
  ],
};

describe('git branch rows', () => {
  it('puts the current branch first with its counts, the others by age, and marks a session branch', () => {
    // Act
    const rows = git.branchRows(LIST, '', NOW);

    // Assert
    expect(rows.local).to.deep.equal([
      { name: 'main', current: true, detail: '↑2 ↓1 · 2h' },
      { name: 'feature/x', current: false, detail: '5m' },
      { name: 'brama/session-1', current: false, detail: 'session · 1d' },
      { name: 'old', current: false, detail: '3d' },
    ]);
    expect(rows.remote).to.deep.equal([
      { name: 'feature/y', remote: 'origin' },
      { name: 'release', remote: 'origin' },
    ]);
  });

  it('shows only the age of a current branch in sync, and "now" for one committed this minute', () => {
    const rows = git.branchRows({ local: [local('main', { current: true, committedAt: NOW - 3 * HOUR }), local('fresh', { committedAt: NOW - 10_000 })], remote: [] }, '', NOW);
    expect(rows.local.map((r) => r.detail)).to.deep.equal(['3h', 'now']);
  });

  it('filters both lists by a part of the name, ignoring case', () => {
    const rows = git.branchRows(LIST, 'FEAT', NOW);
    expect(rows.local.map((r) => r.name)).to.deep.equal(['feature/x']);
    expect(rows.remote.map((r) => r.name)).to.deep.equal(['feature/y']);
  });
});

describe('git switch guard', () => {
  /** @param {string} status @param {string} [folder] */
  const session = (status, folder = '/work/a') => /** @type {import('../../sessions/types.js').Session} */ ({ title: 'Fix it', folder, status });

  it('refuses while an agent works in the project’s folder, saying who', () => {
    expect(git.switchBlocked([session('working')], '/work/a')).to.equal('“Fix it” is working in this folder. Switch branches when it is done.');
    expect(git.switchBlocked([session('queued'), session('waiting')], '/work/a')).to.equal('2 sessions are working in this folder. Switch branches when they are done.');
  });

  it('allows it when the agents are idle or work in another folder', () => {
    expect(git.switchBlocked([session('idle'), session('working', '/work/b')], '/work/a')).to.equal(null);
  });
});
