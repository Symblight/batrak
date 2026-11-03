import { $rootId } from '../../stores/workspace/workspace.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $githubAccount, $githubSignIn, $pullRequest, $pullRequestKey, SIGN_IN_IDLE } from '../../stores/github/github.js';
import { notify } from '../../stores/notices/notices.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { createPr, installCommand, prChip, slot } from './rules.js';

/** @typedef {import('./types.js').GithubAccount} GithubAccount */
/** @typedef {import('./types.js').GithubPrReply} GithubPrReply */

/** Where the one-time code is entered. */
const DEVICE_URL = 'https://github.com/login/device';
/** What the backend rejects a cancelled sign-in with. */
const CANCELLED = 'Sign-in cancelled';
/** Window focus asks `gh` again only after this long. */
const REFRESH_MS = 30_000;
/** A shown pull request is looked up again this often: its checks and reviews change without the branch moving. */
const PR_REFRESH_MS = 60_000;

let refreshedAt = 0;
let pullRequestAt = 0;
/** @type {(() => void) | null} Stops the following that `start()` began. */
let following = null;

/**
 * GitHub through the user's GitHub CLI: who is signed in, and signing in (the CLI opens the
 * browser flow; the app keeps no token).
 */
export const github = Object.freeze({
  slot,
  installCommand,
  prChip,
  createPr,

  /** Asks who is signed in; keeps the last answer if `gh` can't say. */
  async refresh() {
    refreshedAt = Date.now();
    try {
      $githubAccount.set(await ipc.invoke('github_account'));
    } catch (err) {
      app.log('info', `GitHub account unknown: ${err}`);
    }
  },

  /** Looks up the shown branch's pull request, if it is on GitHub and an account is signed in. */
  async refreshPullRequest() {
    const key = $pullRequestKey.get();
    const rootId = $rootId.get();
    const branch = $gitRepo.get().repo?.branch;
    if (key === null || !rootId || !branch) return;
    pullRequestAt = Date.now();
    try {
      /** @type {GithubPrReply} */
      const reply = await ipc.invoke('github_pull_request', { rootId });
      if ($pullRequestKey.get() !== key) return;
      const last = $pullRequest.get();
      // GitHub out of reach: the last answer of this branch stays, marked, until it is reached again.
      if (reply.status === 'error' && last?.rootId === rootId && last.branch === branch && last.reply.status === 'ok') {
        $pullRequest.set({ ...last, reply: { ...last.reply, stale: reply.message ?? 'no answer' } });
        return;
      }
      $pullRequest.set({ rootId, branch, reply });
      // The account stopped working since it was read.
      if (reply.status === 'signedOut') void github.refresh();
    } catch (err) {
      app.log('info', `Pull request lookup failed: ${err}`);
    }
  },

  /**
   * Reads the account now, when the window gets focus and when another window signs in or out; looks
   * up the shown branch's pull request when the branch or its remote commit moves, every minute, and
   * on focus. Once however often it is called.
   * @returns {() => void} Stops.
   */
  start() {
    if (following) return following;
    void github.refresh();
    const onFocus = () => {
      if (Date.now() - refreshedAt > REFRESH_MS) void github.refresh();
      if (Date.now() - pullRequestAt > REFRESH_MS) void github.refreshPullRequest();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void github.refreshPullRequest();
    }, PR_REFRESH_MS);
    const stopKey = $pullRequestKey.subscribe((key) => key && void github.refreshPullRequest());
    const stopAccount = ipc.listen('github://account', () => void github.refresh());
    window.addEventListener('focus', onFocus);
    following = () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
      stopKey();
      stopAccount.then((stop) => stop()).catch(() => {});
      following = null;
    };
    return following;
  },

  /** Signs in: the CLI's one-time code in a dialog, the browser opened on the page for it. */
  async signIn() {
    await github.refresh();
    const account = $githubAccount.get();
    if (account?.state === 'noCli') {
      $githubSignIn.set({ ...SIGN_IN_IDLE, phase: 'noCli', installCommand: installCommand(navigator.platform) });
      return;
    }
    $githubSignIn.set({ ...SIGN_IN_IDLE, phase: 'starting' });
    const stopListening = await ipc.listen('github://code', (/** @type {string} */ code) => {
      // Printed before a cancel stopped the CLI.
      if ($githubSignIn.get().phase !== 'starting') return;
      $githubSignIn.set({ ...SIGN_IN_IDLE, phase: 'code', code });
      app.openUrl(DEVICE_URL).catch((err) => app.reportError('Opening GitHub failed', err));
    });
    try {
      /** @type {GithubAccount} */
      const signedIn = await ipc.invoke('github_sign_in');
      $githubAccount.set(signedIn);
      $githubSignIn.set(SIGN_IN_IDLE);
      if (signedIn.state === 'signedIn') notify('info', `Signed in to GitHub as ${signedIn.login}`);
    } catch (err) {
      const message = String(err);
      // Cancelled by the user: the dialog is closed already.
      if ($githubSignIn.get().phase !== 'idle' && message !== CANCELLED) {
        $githubSignIn.set({ ...SIGN_IN_IDLE, phase: 'failed', error: message });
      }
    } finally {
      stopListening();
    }
  },

  /** Stops a sign-in waiting for the browser and closes the dialog. */
  cancelSignIn() {
    const { phase } = $githubSignIn.get();
    $githubSignIn.set(SIGN_IN_IDLE);
    // Only a running sign-in has a CLI to stop; the backend keeps a cancel for the one about to start.
    if (phase === 'starting' || phase === 'code') ipc.invoke('github_sign_in_cancel').catch(() => {});
  },

  /** Closes the dialog after a failure or a missing CLI. */
  closeSignIn() {
    $githubSignIn.set(SIGN_IN_IDLE);
  },
});
