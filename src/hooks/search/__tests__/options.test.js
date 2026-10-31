import { expect } from '@esm-bundle/chai';
import { initialQuery, optionForKey } from '../options.js';

/**
 * @param {string} code
 * @param {Partial<{ altKey: boolean, metaKey: boolean, ctrlKey: boolean, shiftKey: boolean }>} [mods]
 */
const key = (code, mods = { altKey: true }) => ({ code, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });

describe('search options', () => {
  it('reads Alt+C / W / R by the physical key, and nothing else', () => {
    const cases = [
      // [key, option]
      [key('KeyC'), 'caseSensitive'],
      [key('KeyW'), 'wholeWord'],
      [key('KeyR'), 'regex'],
      [key('KeyX'), null],
      [key('KeyC', {}), null],
      [key('KeyC', { altKey: true, metaKey: true }), null],
      [key('KeyC', { altKey: true, ctrlKey: true }), null],
    ];
    for (const [event, option] of cases) {
      // Act + Assert
      expect(optionForKey(/** @type {ReturnType<typeof key>} */ (event)), JSON.stringify(event)).to.equal(option);
    }
  });

  it('opens a search with a selection on one line (200 characters at most), else the last query', () => {
    const cases = [
      // [selection, query]
      ['  foo  ', 'foo'],
      ['x'.repeat(200), 'x'.repeat(200)],
      ['', 'last'],
      ['   ', 'last'],
      ['a\nb', 'last'],
      ['x'.repeat(201), 'last'],
      [undefined, 'last'],
    ];
    for (const [selection, query] of cases) {
      // Act + Assert
      expect(initialQuery(selection, 'last'), JSON.stringify(selection)?.slice(0, 20)).to.equal(query);
    }
  });
});
