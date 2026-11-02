import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $githubAccount, $githubSignIn, SIGN_IN_IDLE } from '../../../stores/github/github.js';
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

    // Cancelled while waiting
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    answers.github_sign_in = () => new Promise((_, r) => (reject = r));
    const signingIn = github.signIn();
    await until(() => sent('github_sign_in').length === 2);
    github.cancelSignIn();
    reject('Sign-in cancelled');
    await signingIn;
    expect($githubSignIn.get(), 'closed, not failed').to.deep.equal(SIGN_IN_IDLE);
    expect(sent('github_sign_in_cancel')).to.have.length(1);

    // No CLI: nothing is started
    answers.github_account = () => ({ state: 'noCli' });
    await github.signIn();
    expect($githubSignIn.get().phase).to.equal('noCli');
    expect(sent('github_sign_in'), 'no third start').to.have.length(2);
  });
});
