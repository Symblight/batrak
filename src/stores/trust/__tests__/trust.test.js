import { expect } from '@esm-bundle/chai';
import { $awaitingTrust, awaitTrust, takeAwaitingTrust } from '../trust.js';
import { $sessions, newSession, startSession } from '../../sessions/sessions.js';

describe('trust store', () => {
  afterEach(() => {
    $awaitingTrust.set([]);
    $sessions.set([]);
  });

  it('keeps each refused session once until its project is answered', () => {
    const a = newSession('/a');
    startSession(a, { title: 'A', agentId: 'x', config: {}, mode: 'local' });
    const b = newSession('/b');
    startSession(b, { title: 'B', agentId: 'x', config: {}, mode: 'local' });
    awaitTrust(a);
    awaitTrust(a);
    awaitTrust(b);
    expect($awaitingTrust.get()).to.deep.equal([a, b]);
    expect(takeAwaitingTrust('/a')).to.deep.equal([a]);
    expect($awaitingTrust.get()).to.deep.equal([b]);
  });
});
