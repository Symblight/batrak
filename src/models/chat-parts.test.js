import { expect } from '@esm-bundle/chai';
import { fenceCode, splitFencedCode } from './chat-parts.js';

describe('splitFencedCode', () => {
  it('splits a sent prompt back into its text and code parts', () => {
    const text = `sdsd ${fenceCode('const a = 1;\nconst b = 2;', 'javascript')}sdsd`;
    expect(splitFencedCode(text)).to.deep.equal([
      { type: 'text', text: 'sdsd ' },
      { type: 'code', text: 'const a = 1;\nconst b = 2;', lang: 'javascript' },
      { type: 'text', text: 'sdsd' },
    ]);
  });

  it('finds code at the start and end of a trimmed prompt, and code blocks back to back', () => {
    const text = `${fenceCode('a();', 'js')}${fenceCode('', '')}`.trim();
    expect(splitFencedCode(text)).to.deep.equal([
      { type: 'code', text: 'a();', lang: 'js' },
      { type: 'code', text: '', lang: '' },
    ]);
  });

  it('leaves text with no fence as one text part', () => {
    expect(splitFencedCode('see @src/app.js\nand ``` inline')).to.deep.equal([
      { type: 'text', text: 'see @src/app.js\nand ``` inline' },
    ]);
  });
});
