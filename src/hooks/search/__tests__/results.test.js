import { expect } from '@esm-bundle/chai';
import { clipLine, countMatches, highlightParts, matchRows, moveKey, summaryText } from '../results.js';

/** @typedef {import('../types.js').SearchFileResult} SearchFileResult */

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
  it('makes one row per match, with its column, key and UTF-16 length', () => {
    // Act
    const rows = matchRows(RESULTS);
    const emoji = matchRows([{ path: 'e.md', matches: [{ line: 1, text: 'a 😀 b', offset: 0, ranges: [[2, 4]] }] }])[0];
    // Assert
    expect(rows.map((r) => r.key)).to.deep.equal(['src/a.js:3:0', 'src/a.js:3:6', 'src/a.js:7:7', 'src/b.js:1:1']);
    expect(rows[1]).to.deep.equal({ key: 'src/a.js:3:6', path: 'src/a.js', line: 3, column: 7, length: 3, text: 'foo = foo + 1', start: 6, end: 9 });
    expect(rows[3].column, 'offset of the cut line start').to.equal(42);
    expect([emoji.length, emoji.column], 'an emoji is two units').to.deep.equal([2, 3]);
  });

  it('counts and summarizes like the pane', () => {
    const summary = (/** @type {SearchFileResult[]} */ results, searching = false, error = '', query = 'foo') =>
      summaryText({ results, searching, error, query });
    expect(countMatches(RESULTS)).to.deep.equal({ matches: 4, files: 2 });
    expect(countMatches([])).to.deep.equal({ matches: 0, files: 0 });
    expect(summary(RESULTS, true)).to.equal('Searching… 4 results in 2 files');
    expect(summary(RESULTS)).to.equal('4 results in 2 files');
    expect(summary([])).to.equal('No results');
    expect(summary([], false, 'regex parse error', '(')).to.equal('regex parse error');
    expect(summary([], false, '', '')).to.equal('');
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

  it('clips a line: leading whitespace goes, a far match stays visible behind …, a near one is kept', () => {
    const far = clipLine(`${'a'.repeat(100)}foo bar`, 100, 103, 40);
    expect(clipLine('    return foo', 11, 14, 80)).to.deep.equal({ text: 'return foo', start: 7, end: 10 });
    expect(clipLine('\t\tx', 2, 3, 80)).to.deep.equal({ text: 'x', start: 0, end: 1 });
    expect(far.text).to.equal(`…${'a'.repeat(8)}foo bar`);
    expect(far.text.slice(far.start, far.end)).to.equal('foo');
    expect(clipLine('foo bar', 4, 7, 40)).to.deep.equal({ text: 'foo bar', start: 4, end: 7 });
  });

  it('moves the selection by key: from the first row, wrapping one step, clamping longer ones, skipping collapsed groups', () => {
    const rows = matchRows(RESULTS);
    const none = new Set();
    const collapsed = new Set(['src/a.js']);
    expect(moveKey(rows, none, null, 1)).to.equal('src/a.js:3:0');
    expect(moveKey([], none, null, 1)).to.equal(null);
    expect(moveKey(rows, none, 'src/a.js:3:0', 1)).to.equal('src/a.js:3:6');
    expect(moveKey(rows, none, 'src/b.js:1:1', 1)).to.equal('src/a.js:3:0');
    expect(moveKey(rows, none, 'src/a.js:3:0', -1)).to.equal('src/b.js:1:1');
    expect(moveKey(rows, none, 'src/a.js:3:6', 10)).to.equal('src/b.js:1:1');
    expect(moveKey(rows, none, 'src/a.js:3:6', -10)).to.equal('src/a.js:3:0');
    expect(moveKey(rows, collapsed, null, 1)).to.equal('src/b.js:1:1');
    expect(moveKey(rows, collapsed, 'src/b.js:1:1', 1)).to.equal('src/b.js:1:1');
    expect(moveKey(rows, new Set(['src/b.js']), 'src/a.js:7:7', 1)).to.equal('src/a.js:3:0');
  });
});
