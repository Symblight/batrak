import { expect } from '@esm-bundle/chai';
import { clipLine, countMatches, highlightParts, matchRows, moveKey, summaryText } from '../search-results.js';

/** @typedef {import('../../types/types.js').SearchFileResult} SearchFileResult */

// A match the backend's window moved (`offset`), written apart so it type-checks with or without `LineMatch.offset`.
const CUT = { line: 1, text: '…foo', ranges: /** @type {[number, number][]} */ ([[1, 4]]), offset: 40 };

/** @type {SearchFileResult[]} */
const RESULTS = [
  {
    path: 'src/a.js',
    matches: [
      { line: 3, text: 'foo = foo + 1', offset: 0, ranges: [[0, 3], [6, 9]] },
      { line: 7, text: 'return foo', offset: 0, ranges: [[7, 10]] },
    ],
  },
  { path: 'src/b.js', matches: [CUT] },
];

describe('search results', () => {
  it('makes one row per match, with its column and key', () => {
    const rows = matchRows(RESULTS);
    expect(rows.map((r) => r.key)).to.deep.equal(['src/a.js:3:0', 'src/a.js:3:6', 'src/a.js:7:7', 'src/b.js:1:1']);
    expect(rows[1]).to.deep.equal({ key: 'src/a.js:3:6', path: 'src/a.js', line: 3, column: 7, length: 3, text: 'foo = foo + 1', start: 6, end: 9 });
    expect(rows[3].column, 'offset of the cut line start').to.equal(42);
  });

  it('measures length in UTF-16 units', () => {
    const rows = matchRows([{ path: 'e.md', matches: [{ line: 1, text: 'a 😀 b', offset: 0, ranges: [[2, 4]] }] }]);
    expect(rows[0].length).to.equal(2);
    expect(rows[0].column).to.equal(3);
  });

  it('counts matches and files', () => {
    expect(countMatches(RESULTS)).to.deep.equal({ matches: 4, files: 2 });
    expect(countMatches([])).to.deep.equal({ matches: 0, files: 0 });
  });

  it('summarizes like the pane', () => {
    expect(summaryText({ results: RESULTS, searching: true, error: '', query: 'foo' })).to.equal('Searching… 4 results in 2 files');
    expect(summaryText({ results: RESULTS, searching: false, error: '', query: 'foo' })).to.equal('4 results in 2 files');
    expect(summaryText({ results: [], searching: false, error: '', query: 'foo' })).to.equal('No results');
    expect(summaryText({ results: [], searching: false, error: 'regex parse error', query: '(' })).to.equal('regex parse error');
    expect(summaryText({ results: [], searching: false, error: '', query: '' })).to.equal('');
  });

  it('splits a line into plain and hit parts', () => {
    expect(highlightParts('foo = foo + 1', [[0, 3], [6, 9]])).to.deep.equal([
      { text: 'foo', hit: true },
      { text: ' = ', hit: false },
      { text: 'foo', hit: true },
      { text: ' + 1', hit: false },
    ]);
    expect(highlightParts('abc', [[1, 2], [1, 3]]), 'an overlapping range is skipped').to.deep.equal([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ]);
    expect(highlightParts('abc', [])).to.deep.equal([{ text: 'abc', hit: false }]);
  });

  describe('clipLine', () => {
    it('drops leading whitespace, moving the match', () => {
      expect(clipLine('    return foo', 11, 14, 80)).to.deep.equal({ text: 'return foo', start: 7, end: 10 });
      expect(clipLine('\t\tx', 2, 3, 80)).to.deep.equal({ text: 'x', start: 0, end: 1 });
    });

    it('cuts the start with … to keep a far match visible', () => {
      const text = `${'a'.repeat(100)}foo bar`;
      const clipped = clipLine(text, 100, 103, 40);
      expect(clipped.text).to.equal(`…${'a'.repeat(8)}foo bar`);
      expect(clipped.text.slice(clipped.start, clipped.end)).to.equal('foo');
    });

    it('keeps a line whose match fits', () => {
      expect(clipLine('foo bar', 4, 7, 40)).to.deep.equal({ text: 'foo bar', start: 4, end: 7 });
    });
  });

  describe('moveKey', () => {
    const rows = matchRows(RESULTS);
    const none = new Set();

    it('starts at the first row', () => {
      expect(moveKey(rows, none, null, 1)).to.equal('src/a.js:3:0');
      expect(moveKey([], none, null, 1)).to.equal(null);
    });

    it('wraps one step, clamps longer ones', () => {
      expect(moveKey(rows, none, 'src/a.js:3:0', 1)).to.equal('src/a.js:3:6');
      expect(moveKey(rows, none, 'src/b.js:1:1', 1)).to.equal('src/a.js:3:0');
      expect(moveKey(rows, none, 'src/a.js:3:0', -1)).to.equal('src/b.js:1:1');
      expect(moveKey(rows, none, 'src/a.js:3:6', 10)).to.equal('src/b.js:1:1');
      expect(moveKey(rows, none, 'src/a.js:3:6', -10)).to.equal('src/a.js:3:0');
    });

    it('skips collapsed groups', () => {
      const collapsed = new Set(['src/a.js']);
      expect(moveKey(rows, collapsed, null, 1)).to.equal('src/b.js:1:1');
      expect(moveKey(rows, collapsed, 'src/b.js:1:1', 1)).to.equal('src/b.js:1:1');
      expect(moveKey(rows, new Set(['src/b.js']), 'src/a.js:7:7', 1)).to.equal('src/a.js:3:0');
    });
  });
});
