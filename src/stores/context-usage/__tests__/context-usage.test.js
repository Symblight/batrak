import { expect } from '@esm-bundle/chai';
import { $activeContextUsage, $contextUsage, forgetContextUsage, parseContextUsage, setContextUsage } from '../context-usage.js';
import { $activeSessionId } from '../../sessions/sessions.js';

describe('context-usage', () => {
  afterEach(() => {
    for (const id of Object.keys($contextUsage.get())) forgetContextUsage(id);
    $activeSessionId.set(null);
  });

  it('keeps each session\'s last report, the active one\'s shown', () => {
    setContextUsage('a', { used: 1000, size: 200000 });
    setContextUsage('b', { used: 5000, size: 1000000 });
    setContextUsage('a', { used: 2500, size: 200000 });
    expect($contextUsage.get()).to.deep.equal({ a: { used: 2500, size: 200000 }, b: { used: 5000, size: 1000000 } });

    expect($activeContextUsage.get(), 'a draft, or no session').to.equal(null);
    $activeSessionId.set('a');
    expect($activeContextUsage.get()).to.deep.equal({ used: 2500, size: 200000 });
    $activeSessionId.set('c');
    expect($activeContextUsage.get(), 'nothing reported yet').to.equal(null);

    forgetContextUsage('a');
    expect($contextUsage.get()).to.deep.equal({ b: { used: 5000, size: 1000000 } });
  });

  it('stores tokens only, and drops what it can\'t read', () => {
    expect(parseContextUsage({ used: 1, size: 2, cost: { amount: 0.1, currency: 'USD' } })).to.deep.equal({ used: 1, size: 2 });
    expect(parseContextUsage({ used: '1', size: 2 })).to.equal(null);
    expect(parseContextUsage({ size: 2 })).to.equal(null);
    expect(parseContextUsage(null)).to.equal(null);
  });
});
