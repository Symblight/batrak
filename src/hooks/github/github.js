import { $rootId } from '../../stores/project/project.js';
import { $gitRepo } from '../../stores/git/git.js';
import { $githubAccount, $pullRequest, $pullRequestKey } from '../../stores/github/github.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { checksLine, createPr, prChip, slot } from './rules.js';

/** @typedef {import('./types.js').GithubPrReply} GithubPrReply */

/** Window focus asks `gh` again only after this long. */
const REFRESH_MS = 30_000;
/** A shown pull request is looked up again this often: its checks and reviews change without the branch moving. */
const PR_REFRESH_MS = 60_000;

let refreshedAt = 0;
let pullRequestAt = 0;
/** @type {(() => void) | null} Stops the following that `start()` began. */
let following = null;

/**
 * GitHub through the user's GitHub CLI: who is signed in (`gh auth login` in a terminal; the app
 * keeps no token) and the shown branch's pull request.
 */
export const github = Object.freeze({
  slot,
  prChip,
  createPr,
  checksLine,

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
   * Reads the account now, when the window gets focus and when the backend finds the login stopped working; looks
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

});
