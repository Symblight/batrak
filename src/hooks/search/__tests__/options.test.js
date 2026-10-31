import { expect } from '@esm-bundle/chai';
import { initialQuery, optionForKey } from '../options.js';

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

describe('the query a search opens with', () => {
  it('takes a selection on one line, trimmed', () => {
    expect(initialQuery('  foo  ', 'last')).to.equal('foo');
  });

  it("falls back to the project's last query", () => {
    expect(initialQuery('', 'last')).to.equal('last');
    expect(initialQuery('   ', 'last')).to.equal('last');
    expect(initialQuery('a\nb', 'last'), 'more than one line').to.equal('last');
    expect(initialQuery('x'.repeat(201), 'last'), 'over 200 characters').to.equal('last');
    expect(initialQuery(undefined, 'last')).to.equal('last');
  });

  it('takes 200 characters', () => {
    expect(initialQuery('x'.repeat(200), 'last')).to.equal('x'.repeat(200));
  });
});
