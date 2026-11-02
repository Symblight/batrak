import { $githubAccount, $githubSignIn, SIGN_IN_IDLE } from '../../stores/github/github.js';
import { notify } from '../../stores/notices/notices.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { installCommand, slot } from './rules.js';

/** @typedef {import('./types.js').GithubAccount} GithubAccount */

/** Where the one-time code is entered. */
const DEVICE_URL = 'https://github.com/login/device';
/** What the backend rejects a cancelled sign-in with. */
const CANCELLED = 'Sign-in cancelled';
/** Window focus asks `gh` again only after this long. */
const REFRESH_MS = 30_000;

let refreshedAt = 0;

/**
 * GitHub through the user's GitHub CLI: who is signed in, and signing in (the CLI opens the
 * browser flow; the app keeps no token).
 */
export const github = Object.freeze({
  slot,
  installCommand,

  /** Asks who is signed in; keeps the last answer if `gh` can't say. */
  async refresh() {
    refreshedAt = Date.now();
    try {
      $githubAccount.set(await ipc.invoke('github_account'));
    } catch (err) {
      app.log('info', `GitHub account unknown: ${err}`);
    }
  },

  /**
   * Reads the account now and again when the window gets focus.
   * @returns {() => void} Stops.
   */
  start() {
    void github.refresh();
    const onFocus = () => {
      if (Date.now() - refreshedAt > REFRESH_MS) void github.refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
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
    $githubSignIn.set(SIGN_IN_IDLE);
    ipc.invoke('github_sign_in_cancel').catch(() => {});
  },

  /** Closes the dialog after a failure or a missing CLI. */
  closeSignIn() {
    $githubSignIn.set(SIGN_IN_IDLE);
  },
});
