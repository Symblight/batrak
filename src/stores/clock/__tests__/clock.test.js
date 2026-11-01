import { expect } from '@esm-bundle/chai';
import { $now } from '../clock.js';

describe('clock', () => {
  it('says the time while someone listens, and keeps ticking', async () => {
    /** @type {number[]} */
    const seen = [];
    const before = Date.now();
    const stop = $now.subscribe((now) => seen.push(now));
    try {
      expect(seen.length).to.equal(1);
      expect(seen[0]).to.be.at.least(before);
    } finally {
      stop();
    }
  });
});
