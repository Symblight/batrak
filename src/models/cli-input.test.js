import { expect } from '@esm-bundle/chai';
import { cliInput } from './cli-input.js';

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
