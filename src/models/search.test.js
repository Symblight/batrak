import { expect } from '@esm-bundle/chai';
import { optionForKey } from './search.js';

/**
 * @param {string} code
 * @param {Partial<{ altKey: boolean, metaKey: boolean, ctrlKey: boolean, shiftKey: boolean }>} [mods]
 */
const key = (code, mods = { altKey: true }) => ({ code, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });

describe('search options shortcuts', () => {
  it('reads Alt+C / W / R by the physical key', () => {
    expect(optionForKey(key('KeyC'))).to.equal('caseSensitive');
    expect(optionForKey(key('KeyW'))).to.equal('wholeWord');
    expect(optionForKey(key('KeyR'))).to.equal('regex');
  });

  it('ignores other keys, no Alt, and Alt with Mod', () => {
    expect(optionForKey(key('KeyX'))).to.equal(null);
    expect(optionForKey(key('KeyC', {}))).to.equal(null);
    expect(optionForKey(key('KeyC', { altKey: true, metaKey: true }))).to.equal(null);
    expect(optionForKey(key('KeyC', { altKey: true, ctrlKey: true }))).to.equal(null);
  });
});
