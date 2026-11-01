import { expect } from '@esm-bundle/chai';
import {
  $activeNotice,
  $permissionRequests,
  $sessionNotices,
  addPermissionRequest,
  setSessionNotice,
} from '../session-runtime.js';
import { $activeSessionId } from '../../sessions/sessions.js';

describe('session-runtime', () => {
  afterEach(() => {
    $activeSessionId.set(null);
    $sessionNotices.set({});
    $permissionRequests.set({});
  });

  it("says when a queued turn waits on the holder's permission request", () => {
    $activeSessionId.set('b');
    const holder = { id: 'a', title: 'Fix the tree' };
    setSessionNotice('b', { kind: 'queued', message: 'Waiting for "Fix the tree" to finish', holder });
    expect($activeNotice.get()?.message).to.equal('Waiting for "Fix the tree" to finish');
    addPermissionRequest('a', { requestId: 'r', toolCallId: null, title: 'Edit a.txt', options: [] });
    expect($activeNotice.get()).to.deep.equal({ kind: 'queued', message: '"Fix the tree" is waiting for your answer', holder });
  });
});
