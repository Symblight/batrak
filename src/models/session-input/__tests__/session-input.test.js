import { expect } from '@esm-bundle/chai';
import { inputOfInserts, inputOfParts } from '../session-input.js';

/** @typedef {import('../session-input.js').ChxMessagePart} ChxMessagePart */

/** @param {unknown[]} parts */
const chx = (parts) => /** @type {ChxMessagePart[]} */ (parts);

describe('inputOfParts', () => {
  it('keeps each chip as what it names, not its label, in order with the text', () => {
    const parts = chx([
      { type: 'text', text: 'Compare ' },
      { type: 'chip', label: 'editor.js', data: { path: 'src/stores/editor.js' } },
      { type: 'text', text: ' with ' },
      { type: 'chip', label: 'docs', data: { path: '/Users/me/docs', kind: 'folder' } },
      { type: 'text', text: ' and ' },
      { type: 'chip', label: 'src/app.js:12-23', data: { path: 'src/app.js', lines: '12-23' } },
      { type: 'chip', label: 'app.js:7', data: { path: 'app.js', lines: '7' } },
      { type: 'chip', label: '/review', data: {} },
    ]);
    expect(inputOfParts(parts)).to.deep.equal([
      { kind: 'text', text: 'Compare ' },
      { kind: 'ref', path: 'src/stores/editor.js', folder: false },
      { kind: 'text', text: ' with ' },
      { kind: 'ref', path: '/Users/me/docs', folder: true },
      { kind: 'text', text: ' and ' },
      { kind: 'selection', path: 'src/app.js', fromLine: 12, toLine: 23, body: '' },
      { kind: 'selection', path: 'app.js', fromLine: 7, toLine: 7, body: '' },
      { kind: 'command', name: 'review' },
    ]);
  });

  it('keeps pasted code with its language, and a long text paste as is', () => {
    const parts = chx([
      { type: 'code', text: 'let a = 1;', lang: 'js' },
      { type: 'longText', text: 'many lines' },
    ]);
    expect(inputOfParts(parts)).to.deep.equal([
      { kind: 'paste', text: 'let a = 1;', lang: 'js' },
      { kind: 'paste', text: 'many lines', lang: null },
    ]);
  });

  it('keeps the label of a chip that names nothing', () => {
    expect(inputOfParts(chx([{ type: 'chip', label: 'Something', data: {} }]))).to.deep.equal([{ kind: 'text', text: 'Something' }]);
  });
});

describe('inputOfInserts', () => {
  it('puts selections first, each followed by a space, then each comment on a line of its own', () => {
    const inserts = [
      { path: '/p/a.js', fromLine: 1, toLine: 1, body: 'Fix' },
      { path: '/p/b.js', fromLine: 2, toLine: 3, body: '' },
      { path: '/p/c.js', fromLine: 4, toLine: 4, body: 'Why?' },
    ];
    expect(inputOfInserts(inserts)).to.deep.equal([
      { kind: 'selection', path: '/p/b.js', fromLine: 2, toLine: 3, body: '' },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: '\n' },
      { kind: 'selection', path: '/p/a.js', fromLine: 1, toLine: 1, body: 'Fix' },
      { kind: 'text', text: '\n' },
      { kind: 'selection', path: '/p/c.js', fromLine: 4, toLine: 4, body: 'Why?' },
    ]);
  });
});
