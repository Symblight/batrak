import { expect } from '@esm-bundle/chai';
import { persistentMapStore } from '../persistent.js';

/** @param {unknown} raw */
const parse = (raw) => (typeof raw === 'number' ? raw : null);

/**
 * What another window's write looks like here: a `storage` event.
 * @param {string} key
 * @param {string | null} newValue
 */
function otherWindow(key, newValue) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

describe('persistentMapStore', () => {
  it('follows other windows when it listens: their writes and removals', () => {
    const store = persistentMapStore('batrak:test:listening:', parse, { listen: true });
    const stop = store.listen(() => {});

    otherWindow('batrak:test:listening:a', '3');
    expect(store.get()).to.deep.equal({ a: 3 });
    otherWindow('batrak:test:listening:b', '"not a number"');
    expect(store.get().b, 'an entry that does not parse reads as missing').to.equal(undefined);
    otherWindow('batrak:test:listening:a', null);
    expect(store.get().a).to.equal(undefined);
    otherWindow('batrak:test:elsewhere:c', '1');
    expect('c' in store.get(), 'another prefix').to.equal(false);
    stop();
  });

  it('is per window by default: other windows are picked up on the next mount only', () => {
    const store = persistentMapStore('batrak:test:alone:', parse);
    const stop = store.listen(() => {});

    otherWindow('batrak:test:alone:a', '3');
    expect(store.get()).to.deep.equal({});
    stop();
  });
});
