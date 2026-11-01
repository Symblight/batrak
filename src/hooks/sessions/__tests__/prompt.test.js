import { expect } from '@esm-bundle/chai';
import { promptOf } from '../prompt.js';

describe('prompt', () => {
  it("sends a file chip as a mention, and one with an absolute path (outside the session's folder) as its path only", () => {
    const message = /** @type {Parameters<typeof promptOf>[0]} */ (
      /** @type {unknown} */ ({
        id: 'm1',
        parts: [
          { type: 'text', text: 'Compare ' },
          { type: 'chip', label: 'app.js', data: { path: 'src/app.js' } },
          { type: 'text', text: ' with ' },
          { type: 'chip', label: 'notes.md', data: { path: '/Users/me/notes.md' } },
          { type: 'text', text: ' in ' },
          { type: 'chip', label: 'docs', data: { path: '/Users/me/docs', kind: 'folder' } },
        ],
      })
    );
    expect(promptOf(message)).to.deep.equal([
      { type: 'text', text: 'Compare @src/app.js with @/Users/me/notes.md in @/Users/me/docs/' },
      { type: 'mention', path: 'src/app.js' },
    ]);
  });

  it('sends a selection with its lines, a command with its slash and pasted code fenced', () => {
    const message = /** @type {Parameters<typeof promptOf>[0]} */ (
      /** @type {unknown} */ ({
        id: 'm2',
        parts: [
          { type: 'chip', label: '/review', data: {} },
          { type: 'text', text: ' ' },
          { type: 'chip', label: 'src/app.js:12-23', data: { path: 'src/app.js', lines: '12-23' } },
          { type: 'code', text: 'let a = 1;', lang: 'js' },
        ],
      })
    );
    expect(promptOf(message)).to.deep.equal([
      { type: 'text', text: '/review src/app.js:12-23\n```js\nlet a = 1;\n```' },
      { type: 'selection', path: 'src/app.js', fromLine: 12, toLine: 23 },
    ]);
  });
});
