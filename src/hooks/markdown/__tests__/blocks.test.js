import { expect } from '@esm-bundle/chai';
import MarkdownIt from 'markdown-it';
import { blockStarts, createSlugger, slugOf } from '../blocks.js';

/** @param {string} text */
const starts = (text) => blockStarts(new MarkdownIt({ html: true }).parse(text, {}), text).map((b) => b.line);

describe('markdown blocks', () => {
  describe('where blocks start', () => {
    it('numbers the first line of each block, counting the lines blank gaps and fences take', () => {
      const text = ['# Title', '', 'Paragraph', 'goes on', '', '```js', 'const a = 1;', '', 'const b = 2;', '```', '', '- one', '- two', '', '> quote'].join('\n');
      expect(starts(text)).to.deep.equal([1, 3, 6, 12, 15]);
    });

    it('starts after leading blank lines, and counts a block of raw HTML as one', () => {
      expect(starts('\n\n# Late\n\n<div>\n<p>x</p>\n</div>\n\nend')).to.deep.equal([3, 5, 9]);
    });

    it('counts a table, a rule and a definition among the lines, and keeps the block a definition leaves', () => {
      const text = ['| a | b |', '| - | - |', '| 1 | 2 |', '', '---', '', '[ref]: https://a.test', '', 'text [ref]'].join('\n');
      expect(starts(text)).to.deep.equal([1, 5, 9]);
    });

    it('reads each block’s source, for telling a changed block from one that stayed', () => {
      const blocks = blockStarts(new MarkdownIt().parse('# a\n\npara\nmore\n\n- x\n- y', {}), '# a\n\npara\nmore\n\n- x\n- y');
      expect(blocks.map((b) => b.raw)).to.deep.equal(['# a', 'para\nmore', '- x\n- y']);
    });

    it('gives no block for an empty text', () => {
      expect(starts('')).to.deep.equal([]);
      expect(starts('\n\n')).to.deep.equal([]);
    });

    it('reads a Windows file the same as a Unix one', () => {
      expect(starts('# a\r\n\r\nb\r\n\r\nc')).to.deep.equal([1, 3, 5]);
    });
  });

  describe('slugs', () => {
    it('lowercases, drops punctuation and turns spaces into hyphens, as GitHub does', () => {
      expect(slugOf('Hello, World!')).to.equal('hello-world');
      expect(slugOf('  What is this? (really) ')).to.equal('what-is-this-really');
      expect(slugOf('snake_case and kebab-case')).to.equal('snake_case-and-kebab-case');
      expect(slugOf('Привет мир')).to.equal('привет-мир');
      expect(slugOf('`code` & <b>')).to.equal('code--b');
    });

    it('numbers a slug that comes again', () => {
      const slug = createSlugger();
      expect(['Intro', 'Usage', 'Intro', 'intro', 'Usage'].map(slug)).to.deep.equal(['intro', 'usage', 'intro-1', 'intro-2', 'usage-1']);
    });

    it('starts over for each document', () => {
      expect(createSlugger()('A')).to.equal('a');
      expect(createSlugger()('A')).to.equal('a');
    });
  });
});
