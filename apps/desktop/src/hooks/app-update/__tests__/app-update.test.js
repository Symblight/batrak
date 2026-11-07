import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $about } from '../../../stores/about/about.js';
import { $appUpdate, $updateCheck, NO_CHECK } from '../../../stores/app-update/app-update.js';
import { setUnsavedFiles } from '../../../stores/editor/editor.js';
import { $notices, dismissNotice } from '../../../stores/notices/notices.js';
import { appUpdate } from '../app-update.js';

/** @typedef {import('../types.js').AppUpdateState} AppUpdateState */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const AVAILABLE = /** @type {AppUpdateState} */ ({ state: 'available', version: '0.9.3', current: '0.9.2', manual: false });

describe('appUpdate hook', () => {
  /** @type {{ cmd: string, args: unknown }[]} */
  let calls;
  /** @type {Record<string, unknown>} Replies by command; an `Error` is thrown. */
  let replies;
  /** @type {(() => void) | null} */
  let stop = null;

  beforeEach(() => {
    calls = [];
    replies = { app_update_state: { state: 'none' }, app_update_blockers: { agents: 0, terminals: 0 } };
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args });
        const reply = replies[cmd] ?? null;
        if (reply instanceof Error) throw reply;
        return reply;
      },
      { shouldMockEvents: true },
    );
    $appUpdate.set({ state: 'none' });
    setUnsavedFiles(0);
    $updateCheck.set(NO_CHECK);
    $about.set({ version: '0.9.2', os: 'macOS', arch: 'aarch64', logDir: null, updatesEnabled: true });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    for (const notice of $notices.get()) dismissNotice(notice.id);
    $about.set(null);
    clearMocks();
  });

  /**
   * A dialog answering `answer`, and what it was asked.
   * @param {import('../../app/types.js').ConfirmChoice} answer
   */
  function dialogAnswering(answer) {
    /** @type {string[]} */
    const asked = [];
    return {
      asked,
      /** @param {import('../../app/types.js').ConfirmOptions} options */
      choose: async (options) => {
        asked.push(`${options.headline} ${options.message} [${options.cancelLabel}] [${options.confirmLabel}]`);
        return answer;
      },
    };
  }

  const restarted = () => calls.filter((c) => c.cmd === 'app_update_restart').length;

  /** Follows the backend until the page has its first state. */
  async function started() {
    stop = appUpdate.start();
    await until(() => calls.some((c) => c.cmd === 'app_update_state'));
    await new Promise((r) => setTimeout(r));
  }

  it('follows the backend: the state at load, then each change', async () => {
    // Arrange
    replies.app_update_state = AVAILABLE;

    // Act
    await started();

    // Assert
    expect($appUpdate.get(), 'at load').to.deep.equal(AVAILABLE);

    // Act
    const ready = { state: 'ready', version: '0.9.3', onNextLaunch: false };
    await emit('app-update://changed', ready);

    // Assert
    expect($appUpdate.get(), 'on a change').to.deep.equal(ready);
  });

  it('says the update landed', async () => {
    // Arrange
    replies.app_update_state = { state: 'updated', version: '0.9.3' };

    // Act
    await started();

    // Assert
    expect($notices.get().map((n) => [n.message, n.count])).to.deep.equal([['Updated to Batrak 0.9.3', 1]]);
  });

  describe('an event around the first read', () => {
    const READY = /** @type {AppUpdateState} */ ({ state: 'ready', version: '0.9.3', onNextLaunch: false });
    const flush = () => new Promise((r) => setTimeout(r, 20));

    /** The read is under way; the returned function answers it. */
    async function reading() {
      /** @type {(state: AppUpdateState) => void} */
      let answer = () => {};
      replies.app_update_state = new Promise((resolve) => (answer = resolve));
      await started();
      return answer;
    }

    it('keeps the event when it overtakes the reply, and the later event when it follows', async () => {
      /** @type {[string, AppUpdateState, (answer: (state: AppUpdateState) => void) => Promise<unknown>][]} */
      const cases = [
        ['event, then a stale None', READY, async (answer) => (await emit('app-update://changed', READY), answer({ state: 'none' }))],
        ['event, then a stale Installing', READY, async (answer) => (await emit('app-update://changed', READY), answer({ state: 'installing', version: '0.9.3' }))],
        ['reply, then the event', READY, async (answer) => (answer(AVAILABLE), await flush(), emit('app-update://changed', READY))],
      ];
      for (const [why, expected, act] of cases) {
        // Arrange
        $appUpdate.set({ state: 'none' });
        const answer = await reading();

        // Act
        await act(answer);
        await flush();

        // Assert
        expect($appUpdate.get(), why).to.deep.equal(expected);
        stop?.();
      }
    });

    it('still says the update landed when an event overtakes that reply', async () => {
      // Arrange
      const answer = await reading();

      // Act
      await emit('app-update://changed', READY);
      answer({ state: 'updated', version: '0.9.3' });
      await flush();

      // Assert
      expect($appUpdate.get()).to.deep.equal(READY);
      expect($notices.get().map((n) => [n.message, n.count])).to.deep.equal([['Updated to Batrak 0.9.3', 1]]);
    });
  });

  it('restart: at once with nothing busy, else asks and goes only on Restart', async () => {
    /** @type {[{ agents: number, terminals: number }, number, import('../../app/types.js').ConfirmChoice, boolean, string | null, string][]} */
    const cases = [
      [{ agents: 0, terminals: 0 }, 0, 'cancel', true, null, 'nothing busy'],
      [{ agents: 2, terminals: 0 }, 0, 'confirm', true, '2 agents are working', 'agents, Restart'],
      [{ agents: 0, terminals: 1 }, 0, 'cancel', false, '1 terminal is running a program', 'a terminal, Postpone'],
      [{ agents: 0, terminals: 0 }, 1, 'confirm', true, '1 file has unsaved edits', 'a draft, Restart'],
      [{ agents: 0, terminals: 0 }, 2, 'cancel', false, '2 files have unsaved edits', 'drafts, Postpone'],
    ];
    for (const [blockers, drafts, answer, goes, names, why] of cases) {
      // Arrange
      calls = [];
      replies.app_update_blockers = blockers;
      setUnsavedFiles(drafts);
      const dialog = dialogAnswering(answer);

      // Act
      await appUpdate.restart(dialog);

      // Assert
      expect(restarted(), why).to.equal(goes ? 1 : 0);
      expect(dialog.asked.length, `${why}: asked`).to.equal(names === null ? 0 : 1);
      if (names !== null) {
        expect(dialog.asked[0], why).to.contain('Restart Batrak?').and.contain(names).and.contain('[Postpone] [Restart]');
      }
    }
  });

  it("doesn't restart when it can't tell what's busy, and says a refused restart failed", async () => {
    /** @type {[string, Record<string, unknown>, number, string][]} */
    const cases = [
      ['blockers unknown', { app_update_blockers: new Error('no answer') }, 0, 'Restarting to update failed: no answer'],
      ['restart refused', { app_update_restart: new Error('refused') }, 1, 'Restarting to update failed: refused'],
    ];
    for (const [why, failing, attempts, notice] of cases) {
      // Arrange
      calls = [];
      Object.assign(replies, { app_update_blockers: { agents: 0, terminals: 0 }, app_update_restart: null }, failing);
      const dialog = dialogAnswering('confirm');

      // Act
      await appUpdate.restart(dialog);

      // Assert
      expect(restarted(), why).to.equal(attempts);
      expect(dialog.asked, `${why}: nothing to ask`).to.deep.equal([]);
      expect($notices.get().map((n) => n.message), why).to.include(notice);
    }
  });

  describe('Update and Restart', () => {
    const DOWNLOADING = { state: 'downloading', version: '0.9.3', received: 0, total: null };
    const READY = { state: 'ready', version: '0.9.3', onNextLaunch: false };

    /**
     * Update and Restart chosen, its download under way.
     * @param {import('../../app/types.js').ConfirmChoice} [answer]
     */
    async function downloading(answer = 'confirm') {
      replies.app_update_state = AVAILABLE;
      await started();
      const dialog = dialogAnswering(answer);
      await appUpdate.download(dialog);
      await emit('app-update://changed', DOWNLOADING);
      return dialog;
    }

    /** Lets what a state change started reach the backend. */
    const settled = () => new Promise((r) => setTimeout(r, 20));

    it('restarts once when the download is ready, and asks only once when postponed', async () => {
      for (const [answer, expected] of /** @type {const} */ ([['confirm', 1], ['cancel', 0]])) {
        // Arrange
        calls = [];
        replies.app_update_blockers = { agents: 1, terminals: 0 };
        const dialog = await downloading(answer);

        // Act
        await emit('app-update://changed', READY);
        await settled();
        await emit('app-update://changed', { ...READY, onNextLaunch: true });
        await settled();

        // Assert
        expect(calls.some((c) => c.cmd === 'app_update_download'), 'downloads').to.equal(true);
        expect(dialog.asked.length, `${answer}: asked`).to.equal(1);
        expect(restarted(), answer).to.equal(expected);
        stop?.();
      }
    });

    it('forgets the restart after a cancel or a failed download, so a later Ready only waits', async () => {
      /** @type {[string, () => Promise<unknown>][]} */
      const cases = [
        ['cancelled', () => appUpdate.cancel()],
        ['back to Available', () => emit('app-update://changed', AVAILABLE)],
        ['failed', () => emit('app-update://changed', { state: 'failed', version: '0.9.3', reason: 'x' })],
      ];
      for (const [why, end] of cases) {
        // Arrange
        calls = [];
        await downloading();

        // Act
        await end();
        await emit('app-update://changed', READY);
        await settled();

        // Assert
        expect(restarted(), why).to.equal(0);
        stop?.();
      }
    });

    it('forgets the restart when the download is refused, and Retry never restarts', async () => {
      // Arrange: refused
      replies.app_update_state = AVAILABLE;
      await started();
      replies.app_update_download = new Error('this install cannot update itself');

      // Act
      await appUpdate.download(dialogAnswering('confirm'));
      await emit('app-update://changed', READY);
      await settled();

      // Assert
      expect(restarted(), 'refused').to.equal(0);
      expect($notices.get().length, 'says so').to.equal(1);

      // Arrange: Retry
      replies.app_update_download = null;
      await emit('app-update://changed', { state: 'failed', version: '0.9.3', reason: 'x' });

      // Act
      await appUpdate.download(dialogAnswering('confirm'));
      await emit('app-update://changed', READY);
      await settled();

      // Assert
      expect(restarted(), 'Retry').to.equal(0);
    });
  });

  it("check: says Checking…, then the answer or that GitHub wasn't reached, and a reopened About starts clean", async () => {
    /** @type {[unknown, string][]} */
    const cases = [
      [{ state: 'none' }, 'Batrak 0.9.2 is up to date'],
      [AVAILABLE, 'Batrak 0.9.3 is available'],
      [new Error("couldn't reach GitHub"), "Couldn't reach GitHub"],
    ];
    for (const [reply, expected] of cases) {
      // Arrange
      replies.app_update_check = reply;

      // Act
      const asked = appUpdate.check();
      const during = $updateCheck.get();
      await asked;

      // Assert
      expect(during, 'while asking').to.deep.equal({ checking: true, message: 'Checking…' });
      expect($updateCheck.get()).to.deep.equal({ checking: false, message: expected });
    }

    // Act
    appUpdate.forgetCheck();

    // Assert
    expect($updateCheck.get(), 'reopened').to.deep.equal(NO_CHECK);
  });
});
