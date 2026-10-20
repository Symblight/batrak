import { expect } from '@esm-bundle/chai';
import { $unreadSessions, markUnread } from './session-runtime.js';
import { $activeSessionId } from './sessions.js';

describe('session-runtime', () => {
  afterEach(() => {
    $activeSessionId.set(null);
    $unreadSessions.set([]);
  });

  it('marks a hidden session unread until it is shown', () => {
    $activeSessionId.set('shown');
    markUnread('hidden');
    markUnread('hidden');
    expect($unreadSessions.get()).to.deep.equal(['hidden']);
    $activeSessionId.set('hidden');
    expect($unreadSessions.get()).to.deep.equal([]);
  });

  it('never marks the session being shown', () => {
    $activeSessionId.set('shown');
    markUnread('shown');
    expect($unreadSessions.get()).to.deep.equal([]);
  });
});
