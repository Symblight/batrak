import { $about } from '../../stores/about/about.js';
import { $appUpdate, $updateCheck, NO_CHECK } from '../../stores/app-update/app-update.js';
import { $unsavedFiles } from '../../stores/editor/editor.js';
import { notify } from '../../stores/notices/notices.js';
import { app } from '../app/app.js';
import { ipc } from '../ipc/ipc.js';
import { checkMessage, restartMessage } from './rules.js';

/** @typedef {import('./types.js').AppUpdateState} AppUpdateState */
/** @typedef {import('./types.js').RestartBlockers} RestartBlockers */

/**
 * Where the hook asks; a view's own `<acp-confirm-dialog>`.
 * @typedef {Pick<HTMLElementTagNameMap['acp-confirm-dialog'], 'choose'>} Dialog
 */

/** @typedef {Pick<HTMLElementTagNameMap['acp-confirm-dialog'], 'choose' | 'othersClosed'>} WaitingDialog */

/** @type {WaitingDialog | null} Set by **Update and Restart** while its download runs: where that restart asks. */
let restartWhenReady = null;

/** @param {AppUpdateState} state */
function announce(state) {
  if (state.state === 'updated') notify('info', `Updated to Batrak ${state.version}`);
}

/** @param {AppUpdateState} state */
function apply(state) {
  $appUpdate.set(state);
  announce(state);
  if (state.state === 'downloading' || restartWhenReady === null) return;
  const dialog = restartWhenReady;
  restartWhenReady = null;
  if (state.state === 'ready') void restartUnasked(dialog);
}

/**
 * The restart **Update and Restart** promised, at a moment the user didn't pick: it waits for any other
 * question, before reading what's busy and again right before it asks, since one may open in between.
 * @param {WaitingDialog} dialog
 */
async function restartUnasked(dialog) {
  await dialog.othersClosed();
  if ($appUpdate.get().state !== 'ready') return;
  await restart({
    choose: async (options) => {
      await dialog.othersClosed();
      return dialog.choose(options);
    },
  });
}

/** @param {Dialog} dialog */
async function restart(dialog) {
  try {
    const blockers = /** @type {RestartBlockers} */ (await ipc.invoke('app_update_blockers'));
    const message = restartMessage({ ...blockers, drafts: $unsavedFiles.get() });
    if (message !== null) {
      const answer = await dialog.choose({ headline: 'Restart Batrak?', message, cancelLabel: 'Postpone', confirmLabel: 'Restart' });
      if (answer !== 'confirm') return;
    }
    await ipc.invoke('app_update_restart');
  } catch (err) {
    app.reportError('Restarting to update failed', err);
  }
}

/** Updating the app (docs/specs/app-update.md). */
export const appUpdate = Object.freeze({
  /**
   * Follows the backend's state: asked after the listener is on, so no change falls between them. An
   * event can overtake the reply, which is then stale; only `updated` is told once, by the reply.
   * @returns {() => void} Stops following (tests; the app follows for its life).
   */
  start() {
    let changed = false;
    const listening = ipc.listen('app-update://changed', (/** @type {AppUpdateState} */ state) => {
      changed = true;
      apply(state);
    });
    listening
      .then(() => ipc.invoke('app_update_state'))
      .then((reply) => {
        const state = /** @type {AppUpdateState} */ (reply);
        if (changed) announce(state);
        else apply(state);
      })
      .catch((err) => app.log('info', `reading the update state failed: ${err}`));
    return () => void listening.then((off) => off()).catch(() => {});
  },

  /**
   * Restarts into the waiting update, asking first when that loses something.
   * @param {Dialog} dialog
   */
  restart,

  /**
   * Starts the download: **Update and Restart**, which restarts when it's done, or Retry, which doesn't.
   * @param {WaitingDialog} dialog
   */
  async download(dialog) {
    restartWhenReady = $appUpdate.get().state === 'available' ? dialog : null;
    try {
      await ipc.invoke('app_update_download');
    } catch (err) {
      restartWhenReady = null;
      app.reportError('Downloading the update failed', err);
    }
  },

  /** Cancels the download, and the restart waiting for it. */
  cancel() {
    restartWhenReady = null;
    return ipc.invoke('app_update_cancel').catch((err) => app.reportError('Cancelling the download failed', err));
  },

  /** @param {boolean} on The next launch installs what's ready. */
  setOnNextLaunch(on) {
    return ipc.invoke('app_update_on_next_launch', { on }).catch((err) => app.reportError('Saving the choice failed', err));
  },

  /** **Download manually**: the release page. */
  openRelease() {
    return ipc.invoke('app_update_open_release').catch((err) => app.reportError('Opening the release page failed', err));
  },

  /** **Check for updates** in About; what it finds reaches the store as a change of state. */
  async check() {
    $updateCheck.set({ checking: true, message: 'Checking…' });
    let message;
    try {
      const state = /** @type {AppUpdateState} */ (await ipc.invoke('app_update_check'));
      message = checkMessage(state, $about.get()?.version ?? '');
    } catch {
      message = "Couldn't reach GitHub";
    }
    $updateCheck.set({ checking: false, message });
  },

  /** About opens again: an old answer may not hold any more. A check still running keeps its row. */
  forgetCheck() {
    if (!$updateCheck.get().checking) $updateCheck.set(NO_CHECK);
  },
});
