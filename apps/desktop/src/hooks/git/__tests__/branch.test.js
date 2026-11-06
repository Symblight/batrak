import { expect } from '@esm-bundle/chai';
import { git } from '../git.js';

/** @param {Partial<import('../types.js').GitRepoState>} [fields] @returns {import('../types.js').GitRepoState} */
const repo = (fields = {}) => ({
  branch: 'main',
  sha: 'abc1234',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  upstreamSha: null,
  remote: { name: 'origin', url: 'git@github.com:a/b.git', github: { owner: 'a', repo: 'b' } },
  ...fields,
});

describe('git branch', () => {
  it('says how the branch stands against its remote, as of the last fetch', () => {
    /** @type {[Partial<import('../types.js').GitRepoState>, string][]} */
    const cases = [
      [{}, 'In sync with origin'],
      [{ ahead: 2 }, '2 commits to push to origin'],
      [{ behind: 1 }, '1 commit to pull from origin'],
      [{ ahead: 1, behind: 3 }, '1 to push, 3 to pull: diverged from origin'],
      [{ upstream: null }, 'Not on origin yet'],
      [{ upstream: null, remote: null }, 'No remote'],
    ];
    for (const [fields, line] of cases) {
      // Act + Assert
      expect(git.remoteLine(repo(fields)), JSON.stringify(fields)).to.equal(line);
    }
  });

  it('leaves the current branch out of what can be compared to, also as git lists one a tag shadows', () => {
    // Arrange
    const list = { local: ['main', 'dev'], remotes: [{ remote: 'origin', branches: ['origin/main'] }], default: 'origin/main' };
    // Act
    const left = git.compareBranches(list, repo({ branch: 'main' }));
    const shadowed = git.compareBranches({ ...list, local: ['heads/main', 'dev'] }, repo({ branch: 'main' }));
    const detached = git.compareBranches(list, repo({ branch: null, detached: true }));
    // Assert
    expect(left).to.deep.equal({ ...list, local: ['dev'] });
    expect(shadowed.local).to.deep.equal(['dev']);
    expect(detached).to.deep.equal(list);
  });
});
