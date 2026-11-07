import { expect } from '@esm-bundle/chai';
import { checkMessage, downloadProgress, restartMessage } from '../rules.js';

describe('app update rules', () => {
  it('restartMessage: names only what a restart would lose, in the right number', () => {
    /** @type {[number, number, number, string | null][]} */
    const cases = [
      [0, 0, 0, null],
      [1, 0, 0, '1 agent is working. Restarting stops it. You can continue each session after the update.'],
      [2, 1, 0, '2 agents are working, 1 terminal is running a program. Restarting stops them. You can continue each session after the update.'],
      [0, 1, 0, '1 terminal is running a program. Restarting stops it.'],
      [0, 3, 0, '3 terminals are running a program. Restarting stops them.'],
      [0, 0, 1, '1 file has unsaved edits, which will be lost.'],
      [0, 0, 2, '2 files have unsaved edits, which will be lost.'],
      [1, 1, 1, '1 agent is working, 1 terminal is running a program. Restarting stops them. You can continue each session after the update. 1 file has unsaved edits, which will be lost.'],
    ];
    for (const [agents, terminals, drafts, expected] of cases) {
      // Act
      const message = restartMessage({ agents, terminals, drafts });

      // Assert
      expect(message, `${agents} ${terminals} ${drafts}`).to.equal(expected);
    }
  });

  it('checkMessage: what About says after a check, for each state it can return', () => {
    /** @type {[import('../types.js').AppUpdateState, string][]} */
    const cases = [
      [{ state: 'none' }, 'Batrak 0.9.2 is up to date'],
      [{ state: 'available', version: '0.9.3', current: '0.9.2', manual: false }, 'Batrak 0.9.3 is available'],
      [{ state: 'downloading', version: '0.9.3', received: 0, total: null }, 'Batrak 0.9.3 is available'],
      [{ state: 'ready', version: '0.9.3', onNextLaunch: false }, 'Batrak 0.9.3 is available'],
      [{ state: 'installing', version: '0.9.3' }, 'Batrak 0.9.3 is available'],
      [{ state: 'failed', version: '0.9.3', reason: 'x' }, 'Batrak 0.9.3 is available'],
    ];
    for (const [state, expected] of cases) {
      // Act
      const message = checkMessage(state, '0.9.2');

      // Assert
      expect(message, state.state).to.equal(expected);
    }
  });

  it('downloadProgress: whole percents and megabytes, and no percent without a total', () => {
    const MB = 1024 * 1024;
    /** @type {[number, number | null, number | null, string][]} */
    const cases = [
      [16 * MB, 38 * MB, 42, '16 of 38 MB'],
      [0, 38 * MB, 0, '0 of 38 MB'],
      [38 * MB, 38 * MB, 100, '38 of 38 MB'],
      [5 * MB, null, null, '5 MB'],
      [0, 0, null, '0 MB'],
    ];
    for (const [received, total, percent, size] of cases) {
      // Act
      const progress = downloadProgress(received, total);

      // Assert
      expect(progress, `${received} of ${total}`).to.deep.equal({ percent, size });
    }
  });
});
