import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $gitRepo } from '../../../stores/git/git.js';
import { $githubAccount, $pullRequestHere } from '../../../stores/github/github.js';
import { $project } from '../../../stores/project/project.js';
import { $notices } from '../../../stores/notices/notices.js';
import { github } from '../github.js';

/** @type {{ cmd: string, args: Record<string, any> }[]} */
let calls;
/** @type {Record<string, (args: Record<string, any>) => unknown>} */
let answers;

const sent = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd);
/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(3000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('github', () => {
  beforeEach(() => {
    calls = [];
    answers = { github_account: () => ({ state: 'signedOut' }) };
    $githubAccount.set(null);
    $githubAccount.set(null);
    $project.set(null);
    $gitRepo.set({ repo: null, error: null });
    $notices.set([]);
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args: /** @type {Record<string, any>} */ (args ?? {}) });
        return answers[cmd]?.(/** @type {Record<string, any>} */ (args ?? {})) ?? null;
      },
      { shouldMockEvents: true },
    );
  });
  afterEach(() => clearMocks());

  it('looks up the shown branch\'s pull request once signed in, again when the branch moves, and not for what is not on GitHub', async () => {
    // Arrange
    const reply = { status: 'ok', pr: { number: 8, title: 'T', url: 'u', state: 'OPEN', isDraft: false, reviewDecision: null, checks: null }, defaultBranch: 'main', message: null };
    answers.github_pull_request = () => reply;
    const onGithub = { name: 'origin', url: 'https://github.com/a/b.git', github: { owner: 'a', repo: 'b' } };
    const repo = { branch: 'feat', sha: 's', detached: false, upstream: 'origin/feat', ahead: 0, behind: 0, upstreamSha: 'u1', remote: onGithub };
    const stop = github.start();
    await until(() => sent('github_account').length === 1);
    $project.set({ path: '/work/a', name: 'a', rootId: 'r1' });

    // Act: not signed in, then signed in
    $gitRepo.set({ repo, error: null });
    $githubAccount.set({ state: 'signedOut' });
    await new Promise((r) => setTimeout(r, 30));
    const whileSignedOut = sent('github_pull_request').length;
    $githubAccount.set({ state: 'signedIn', login: 'octo' });
    await until(() => $pullRequestHere.get() !== null);
    // Assert
    expect(whileSignedOut).to.equal(0);
    expect(sent('github_pull_request').map((c) => c.args)).to.deep.equal([{ rootId: 'r1' }]);
    expect($pullRequestHere.get()).to.deep.equal({ rootId: 'r1', branch: 'feat', reply });

    // Act: a push moves the remote commit; counts alone do not matter
    $gitRepo.set({ repo: { ...repo, behind: 2 }, error: null });
    $gitRepo.set({ repo: { ...repo, upstreamSha: 'u2' }, error: null });
    await until(() => sent('github_pull_request').length === 2);
    // Assert
    expect(sent('github_pull_request')).to.have.length(2);

    // Act: another branch has no lookup of its own yet, and a remote elsewhere has none at all
    $gitRepo.set({ repo: { ...repo, branch: 'other', remote: { ...onGithub, github: null } }, error: null });
    await new Promise((r) => setTimeout(r, 30));
    // Assert
    expect($pullRequestHere.get(), 'not feat\'s').to.equal(null);
    expect(sent('github_pull_request')).to.have.length(2);
    stop();
  });

  it('follows the account once however often it is started, and reads it again when another window signs in', async () => {
    // Arrange
    const stops = [github.start(), github.start()];
    await until(() => sent('github_account').length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    const reads = sent('github_account').length;
    // Act
    await emit('github://account');
    await until(() => sent('github_account').length > reads);
    await new Promise((r) => setTimeout(r, 30));
    // Assert
    expect(reads, 'one read at start').to.equal(1);
    expect(sent('github_account').length, 'one read per event').to.equal(reads + 1);
    stops.forEach((stop) => stop());
  });

  it('keeps the last pull request it found while GitHub can\'t be reached, marked as such', async () => {
    // Arrange
    const found = { status: 'ok', pr: { number: 8, title: 'T', url: 'u', state: 'OPEN', isDraft: false, reviewDecision: null, checks: null }, defaultBranch: 'main', message: null };
    answers.github_pull_request = () => found;
    const onGithub = { name: 'origin', url: 'https://github.com/a/b.git', github: { owner: 'a', repo: 'b' } };
    $project.set({ path: '/work/a', name: 'a', rootId: 'r1' });
    $gitRepo.set({ repo: { branch: 'feat', sha: 's', detached: false, upstream: 'origin/feat', ahead: 0, behind: 0, upstreamSha: 'u1', remote: onGithub }, error: null });
    $githubAccount.set({ state: 'signedIn', login: 'octo' });
    await github.refreshPullRequest();
    answers.github_pull_request = () => ({ status: 'error', pr: null, defaultBranch: null, message: 'error connecting to api.github.com' });
    // Act
    await github.refreshPullRequest();
    // Assert
    expect($pullRequestHere.get()?.reply).to.deep.equal({ ...found, stale: 'error connecting to api.github.com' });
  });
});
