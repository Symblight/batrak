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

  it('lets the pull request lookup narrow a working account: no access, or a login that stopped working', () => {
    const account = /** @type {const} */ ({ state: 'signedIn', login: 'octo' });
    expect(github.slot(repo(), account, { status: 'noAccess', pr: null, defaultBranch: null, message: 'x' })).to.equal('noAccess');
    expect(github.slot(repo(), account, { status: 'signedOut', pr: null, defaultBranch: null, message: 'x' })).to.equal('signedOut');
    expect(github.slot(repo(), account, { status: 'error', pr: null, defaultBranch: null, message: 'x' }), 'unreachable: keep the last view').to.equal('ok');
    expect(github.slot(repo(), account, null)).to.equal('ok');
  });

  it('shows a pull request as a state, a number, and its checks and reviews in words', () => {
    /** @param {Partial<import('../types.js').GithubPullRequest>} [fields] @returns {import('../types.js').GithubPullRequest} */
    const pr = (fields = {}) => ({ number: 128, title: 'T', url: 'u', state: 'OPEN', isDraft: false, reviewDecision: null, checks: null, ...fields });
    /** @type {[Partial<import('../types.js').GithubPullRequest>, Record<string, unknown>][]} */
    const cases = [
      [{}, { state: 'open', label: '#128 Open', icon: 'merge_type', checks: null, tooltip: 'Open' }],
      [{ checks: 'SUCCESS', reviewDecision: 'APPROVED' }, { state: 'open', checks: 'ok', tooltip: 'Open · checks passed · approved' }],
      [{ checks: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED' }, { checks: 'fail', tooltip: 'Open · 1 check failed · changes requested' }],
      [{ checks: 'ERROR' }, { checks: 'fail' }],
      [{ checks: 'PENDING', reviewDecision: 'REVIEW_REQUIRED' }, { checks: 'run', tooltip: 'Open · checks running · review required' }],
      [{ isDraft: true, checks: 'EXPECTED' }, { state: 'draft', label: '#128 Draft', icon: 'edit_note', checks: 'run' }],
      [{ state: 'MERGED', checks: 'FAILURE' }, { state: 'merged', label: '#128 Merged', icon: 'merge', checks: null, tooltip: 'Merged' }],
      [{ state: 'CLOSED' }, { state: 'closed', label: '#128 Closed', icon: 'close', tooltip: 'Closed without merging' }],
    ];
    for (const [fields, expected] of cases) {
      expect(github.prChip(pr(fields)), JSON.stringify(fields)).to.deep.include(expected);
    }
  });

  it('opens a pull request from the compare page only for a published branch that is not the default one', () => {
    /** @type {[string, import('../../git/types.js').GitRepoState, string | null, string | null, string][]} */
    const cases = [
      ['published', repo({ branch: 'feature/x y' }), 'main', 'https://github.com/a/b/compare/main...feature/x%20y?expand=1', 'Create a pull request for feature/x y'],
      ['not published', repo({ upstream: null }), 'main', null, 'Publish the branch first'],
      ['the default branch', repo(), 'main', null, 'This is the default branch'],
      ['default unknown', repo({ branch: 'dev' }), null, 'https://github.com/a/b/compare/dev?expand=1', 'Create a pull request for dev'],
    ];
    for (const [why, state, base, url, tooltip] of cases) {
      expect(github.createPr(state, base), why).to.deep.equal({ url, tooltip });
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
