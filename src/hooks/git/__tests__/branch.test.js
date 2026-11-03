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
});
