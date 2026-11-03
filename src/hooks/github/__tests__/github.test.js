import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $gitRepo } from '../../../stores/git/git.js';
import { $githubAccount, $githubSignIn, $pullRequestHere, SIGN_IN_IDLE } from '../../../stores/github/github.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
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

describe('github sign-in', () => {
  beforeEach(() => {
    calls = [];
    answers = { github_account: () => ({ state: 'signedOut' }) };
    $githubAccount.set(null);
    $githubSignIn.set(SIGN_IN_IDLE);
    $githubAccount.set(null);
    $workspace.set(null);
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

  it('shows the one-time code and opens the page for it, then closes with a notice once the CLI is done', async () => {
    // Arrange
    /** @type {(account: unknown) => void} */
    let finish = () => {};
    answers.github_sign_in = () => new Promise((resolve) => (finish = resolve));
    answers.open_url = () => null;
    // Act
    const signingIn = github.signIn();
    await until(() => sent('github_sign_in').length === 1);
    const starting = $githubSignIn.get().phase;
    await emit('github://code', '91BE-580F');
    await until(() => $githubSignIn.get().phase === 'code');
    // Assert
    expect(starting).to.equal('starting');
    expect($githubSignIn.get().code).to.equal('91BE-580F');
    expect(sent('open_url').map((c) => c.args.url), 'the page the code goes to').to.deep.equal(['https://github.com/login/device']);
    // Act
    finish({ state: 'signedIn', login: 'octo' });
    await signingIn;
    // Assert
    expect($githubSignIn.get()).to.deep.equal(SIGN_IN_IDLE);
    expect($githubAccount.get()).to.deep.equal({ state: 'signedIn', login: 'octo' });
    expect($notices.get().map((n) => n.message)).to.deep.equal(['Signed in to GitHub as octo']);
  });

  it('says why a sign-in failed, says nothing of one the user cancelled, and asks to install a missing CLI', async () => {
    // Failed in the browser
    answers.github_sign_in = () => {
      throw 'authorization was declined';
    };
    await github.signIn();
    expect($githubSignIn.get()).to.deep.include({ phase: 'failed', error: 'authorization was declined' });
    github.cancelSignIn();
    expect(sent('github_sign_in_cancel'), 'closing a failed one has nothing to stop').to.have.length(0);

    // Cancelled while waiting
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    answers.github_sign_in = () => new Promise((_, r) => (reject = r));
    const signingIn = github.signIn();
    await until(() => sent('github_sign_in').length === 2);
    github.cancelSignIn();
    await emit('github://code', '91BE-580F'); // printed by the CLI before it was stopped
    reject('Sign-in cancelled');
    await signingIn;
    expect($githubSignIn.get(), 'closed, not failed').to.deep.equal(SIGN_IN_IDLE);
    expect(sent('github_sign_in_cancel')).to.have.length(1);
    expect(sent('open_url'), 'no browser for a cancelled sign-in').to.have.length(0);

    // No CLI: nothing is started
    answers.github_account = () => ({ state: 'noCli' });
    await github.signIn();
    expect($githubSignIn.get().phase).to.equal('noCli');
    expect(sent('github_sign_in'), 'no third start').to.have.length(2);
  });
  it('looks up the shown branch\'s pull request once signed in, again when the branch moves, and not for what is not on GitHub', async () => {
    // Arrange
    const reply = { status: 'ok', pr: { number: 8, title: 'T', url: 'u', state: 'OPEN', isDraft: false, reviewDecision: null, checks: null }, defaultBranch: 'main', message: null };
    answers.github_pull_request = () => reply;
    const onGithub = { name: 'origin', url: 'https://github.com/a/b.git', github: { owner: 'a', repo: 'b' } };
    const repo = { branch: 'feat', sha: 's', detached: false, upstream: 'origin/feat', ahead: 0, behind: 0, upstreamSha: 'u1', remote: onGithub, hasRemotes: true, fetchedAt: null };
    const stop = github.start();
    await until(() => sent('github_account').length === 1);
    $workspace.set({ path: '/work/a', name: 'a', rootId: 'r1' });

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
    $workspace.set({ path: '/work/a', name: 'a', rootId: 'r1' });
    $gitRepo.set({ repo: { branch: 'feat', sha: 's', detached: false, upstream: 'origin/feat', ahead: 0, behind: 0, upstreamSha: 'u1', remote: onGithub, hasRemotes: true, fetchedAt: null }, error: null });
    $githubAccount.set({ state: 'signedIn', login: 'octo' });
    await github.refreshPullRequest();
    answers.github_pull_request = () => ({ status: 'error', pr: null, defaultBranch: null, message: 'error connecting to api.github.com' });
    // Act
    await github.refreshPullRequest();
    // Assert
    expect($pullRequestHere.get()?.reply).to.deep.equal({ ...found, stale: 'error connecting to api.github.com' });
  });
});
