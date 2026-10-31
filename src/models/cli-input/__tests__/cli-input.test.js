import { expect } from '@esm-bundle/chai';
import { cliInput, cliPromptOf } from '../cli-input.js';

describe('cliPromptOf', () => {
  it('writes each ref with its whole path, as the CLI reads one', () => {
    /** @type {import('../../types/types.js').InputPart[]} */
    const parts = [
      { kind: 'text', text: 'Compare ' },
      { kind: 'ref', path: 'src/stores/editor.js', folder: false },
      { kind: 'text', text: ' in ' },
      { kind: 'ref', path: 'src', folder: true },
      { kind: 'text', text: ' with ' },
      { kind: 'ref', path: '/Users/me/notes.md', folder: false },
      { kind: 'text', text: ' at ' },
      { kind: 'selection', path: 'src/app.js', fromLine: 12, toLine: 23, body: '' },
    ];
    expect(cliPromptOf(parts, '/p')).to.equal('Compare @src/stores/editor.js in @src/ with @/Users/me/notes.md at @src/app.js#L12-23');
  });

  it('writes a command with its slash, pasted code fenced and a long paste as is', () => {
    /** @type {import('../../types/types.js').InputPart[]} */
    const parts = [
      { kind: 'command', name: 'review' },
      { kind: 'text', text: ' this' },
      { kind: 'paste', text: 'let a = 1;', lang: 'js' },
      { kind: 'paste', text: 'many lines', lang: null },
    ];
    expect(cliPromptOf(parts, '/p')).to.equal('/review this\n```js\nlet a = 1;\n```\nmany lines');
  });
});

describe('cliInput', () => {
  it('writes a selection as an @ ref with its lines, relative to the root, then a space', () => {
    expect(cliInput([{ path: '/p/src/app.js', fromLine: 3, toLine: 5, body: '' }], '/p')).to.equal('@src/app.js#L3-5 ');
  });

  it('writes one line without a range', () => {
    expect(cliInput([{ path: '/p/app.js', fromLine: 7, toLine: 7, body: '' }], '/p')).to.equal('@app.js#L7 ');
  });

  it('keeps a path outside the root absolute', () => {
    expect(cliInput([{ path: '/elsewhere/a.js', fromLine: 1, toLine: 2, body: '' }], '/p')).to.equal('@/elsewhere/a.js#L1-2 ');
  });

  it('writes each comment on its own line: its ref, then its text', () => {
    const inserts = [
      { path: '/p/a.js', fromLine: 1, toLine: 2, body: 'Rename this' },
      { path: '/p/b.js', fromLine: 4, toLine: 4, body: 'Why?\nIt looks unused' },
    ];
    expect(cliInput(inserts, '/p')).to.equal('@a.js#L1-2 Rename this\n@b.js#L4 Why?\nIt looks unused');
  });

  it('puts selections first, then the comments on lines of their own', () => {
    const inserts = [
      { path: '/p/a.js', fromLine: 1, toLine: 1, body: 'Fix' },
      { path: '/p/b.js', fromLine: 2, toLine: 3, body: '' },
    ];
    expect(cliInput(inserts, '/p')).to.equal('@b.js#L2-3 \n@a.js#L1 Fix');
  });
});
