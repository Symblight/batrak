import { expect } from '@esm-bundle/chai';
import { chat } from '../chat.js';

describe('chat file refs', () => {
  it('reads a whole string as a file or folder ref, with its lines and its @', () => {
    /** @type {[string, import('../chat.js').FileRef | null, string][]} */
    const cases = [
      // [text, expected, why]
      ['src/app.js', { path: 'src/app.js', folder: false, fromLine: null, toLine: null, mention: false }, 'plain path'],
      ['@src/app.js', { path: 'src/app.js', folder: false, fromLine: null, toLine: null, mention: true }, 'mention'],
      ['src/app.js:12', { path: 'src/app.js', folder: false, fromLine: 12, toLine: 12, mention: false }, 'one line'],
      ['src/app.js:12-23', { path: 'src/app.js', folder: false, fromLine: 12, toLine: 23, mention: false }, 'range'],
      ['/abs/app.js#L12-L23', { path: '/abs/app.js', folder: false, fromLine: 12, toLine: 23, mention: false }, 'GitHub style'],
      ['file:///abs/app.js', { path: '/abs/app.js', folder: false, fromLine: null, toLine: null, mention: false }, 'file URL'],
      ['src/components/', { path: 'src/components', folder: true, fromLine: null, toLine: null, mention: false }, 'folder'],
      ['this.value', null, 'a property access is no file'],
      ['v1.2', null, 'a version is no file'],
      ['a//b.js', null, 'empty segment'],
    ];
    for (const [text, expected, why] of cases) expect(chat.parseFileRef(text), why).to.deep.equal(expected);
  });

  it('finds refs in running text, leaving bare names, domains and plain folders as text', () => {
    /** @type {[string, string[], string[]][]} */
    const cases = [
      ['see @src/app.js:12, and src/b.js.', ['see ', '@src/app.js:12', ', and ', 'src/b.js', '.'], ['@src/app.js:12', 'src/b.js']],
      ['a bare app.js is a word, and/or/ too', ['a bare app.js is a word, and/or/ too'], []],
      ['open @src/lib/ now', ['open ', '@src/lib/', ' now'], ['@src/lib/']],
    ];
    for (const [text, texts, refs] of cases) {
      const segments = chat.splitFileRefs(text);
      expect(segments.map((s) => s.text), text).to.deep.equal(texts);
      expect(segments.filter((s) => s.ref).map((s) => s.text), text).to.deep.equal(refs);
    }
  });

  it('shows lines as 12 or 12-23, and makes a path absolute with . and .. resolved', () => {
    const ref = (/** @type {number | null} */ fromLine, /** @type {number | null} */ toLine) => ({ path: 'a.js', folder: false, fromLine, toLine, mention: false });
    expect([chat.linesOf(ref(null, null)), chat.linesOf(ref(12, 12)), chat.linesOf(ref(12, 23)), chat.linesOf(ref(12, null))]).to.deep.equal(['', '12', '12-23', '12']);
    /** @type {[string, string | null, string | null][]} */
    const cases = [
      ['src/a.js', '/p', '/p/src/a.js'],
      ['./src/../b.js', '/p', '/p/b.js'],
      ['/abs/./x', null, '/abs/x'],
      ['src/a.js', null, null],
      ['/../x', '/p', null],
    ];
    for (const [path, root, expected] of cases) expect(chat.absoluteRefPath(path, root), `${path} in ${root}`).to.equal(expected);
  });
});
