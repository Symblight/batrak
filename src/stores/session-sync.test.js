import { expect } from '@esm-bundle/chai';
import { $sessionSync, endSync, startSync, syncOf } from './session-sync.js';

/** @type {import('../models/types.js').SyncReport} */
const REPORT = { projectPath: '/p', startedAt: 'a', endedAt: 'b', agents: [] };

describe('session-sync', () => {
  afterEach(() => $sessionSync.set({}));

  it('keeps each project\'s sync: running, then its report', () => {
    expect(syncOf('/p')).to.deep.equal({ running: false, report: null });
    startSync('/p');
    expect(syncOf('/p')).to.deep.equal({ running: true, report: null });
    endSync('/p', REPORT);
    expect(syncOf('/p')).to.deep.equal({ running: false, report: REPORT });
    expect(syncOf('/q').report).to.equal(null);
  });

  it('keeps the last report when a sync fails', () => {
    endSync('/p', REPORT);
    startSync('/p');
    endSync('/p', null);
    expect(syncOf('/p')).to.deep.equal({ running: false, report: REPORT });
  });
});
