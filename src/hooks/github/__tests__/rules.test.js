import { expect } from '@esm-bundle/chai';
import { github } from '../github.js';

/** @param {Partial<import('../../git/types.js').GitRepoState>} [fields] @returns {import('../../git/types.js').GitRepoState} */
const repo = (fields = {}) => ({
  branch: 'main',
  sha: 'abc1234',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  upstreamSha: null,
  remote: { name: 'origin', url: 'https://github.com/a/b.git', github: { owner: 'a', repo: 'b' } },
  hasRemotes: true,
  fetchedAt: null,
  ...fields,
});

describe('github rules', () => {
  it('shows the GitHub slot only for a branch on github.com, by what the CLI says', () => {
    /** @type {[string, import('../../git/types.js').GitRepoState | null, import('../types.js').GithubAccount | null, string][]} */
    const cases = [
      ['signed in', repo(), { state: 'signedIn', login: 'octo' }, 'ok'],
      ['signed out', repo(), { state: 'signedOut' }, 'signedOut'],
      ['no CLI', repo(), { state: 'noCli' }, 'noCli'],
      ['account not read yet', repo(), null, 'loading'],
      ['another host', repo({ remote: { name: 'origin', url: 'u', github: null } }), { state: 'signedOut' }, 'hidden'],
      ['no remote', repo({ remote: null, hasRemotes: false }), { state: 'signedOut' }, 'hidden'],
      ['detached', repo({ branch: null, detached: true }), { state: 'signedOut' }, 'hidden'],
      ['no repository', null, { state: 'signedOut' }, 'hidden'],
    ];
    for (const [why, state, account, expected] of cases) {
      expect(github.slot(state, account), why).to.equal(expected);
    }
  });

  it('names the install command of the system, where there is one', () => {
    expect([github.installCommand('MacIntel'), github.installCommand('Win32'), github.installCommand('Linux x86_64')]).to.deep.equal([
      'brew install gh',
      'winget install --id GitHub.cli',
      null,
    ]);
  });
});
