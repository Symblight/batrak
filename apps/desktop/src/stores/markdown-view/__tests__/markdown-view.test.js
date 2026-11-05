import { expect } from '@esm-bundle/chai';
import { $markdownModes, modeOf, parseModes, pruneModes, setMode } from '../markdown-view.js';

describe('markdown view modes', () => {
  afterEach(() => {
    for (const project of ['/p', '/q']) $markdownModes.setKey(project, undefined);
  });

  it('shows the default for a file that was never set', () => {
    expect(modeOf('/p', 'docs/a.md', 'raw')).to.equal('raw');
    expect(modeOf('/p', 'docs/a.md', 'preview')).to.equal('preview');
    expect(modeOf(null, 'a.md', 'split')).to.equal('split');
  });

  it('remembers a file’s mode per project, in storage of its own', () => {
    setMode('/p', 'docs/a.md', 'split', 'raw');
    setMode('/p', 'b.md', 'preview', 'raw');
    setMode('/q', 'docs/a.md', 'preview', 'raw');

    expect(modeOf('/p', 'docs/a.md', 'raw')).to.equal('split');
    expect(modeOf('/p', 'b.md', 'raw')).to.equal('preview');
    expect(modeOf('/q', 'docs/a.md', 'raw')).to.equal('preview');
    expect(modeOf('/q', 'b.md', 'raw')).to.equal('raw');
    expect(JSON.parse(localStorage.getItem('batrak:markdown:mode:/p') ?? 'null')).to.deep.equal({ 'docs/a.md': 'split', 'b.md': 'preview' });
  });

  it('keeps only the modes that differ from the default, and forgets a project left with none', () => {
    setMode('/p', 'a.md', 'split', 'raw');
    setMode('/p', 'b.md', 'split', 'raw');

    setMode('/p', 'a.md', 'raw', 'raw');
    expect(JSON.parse(localStorage.getItem('batrak:markdown:mode:/p') ?? 'null')).to.deep.equal({ 'b.md': 'split' });

    setMode('/p', 'b.md', 'raw', 'raw');
    expect(localStorage.getItem('batrak:markdown:mode:/p')).to.equal(null);
    expect($markdownModes.get()['/p']).to.equal(undefined);
  });

  it('writes nothing when a file stays as it is', () => {
    setMode('/p', 'a.md', 'raw', 'raw');
    expect(localStorage.getItem('batrak:markdown:mode:/p')).to.equal(null);

    setMode('/p', 'a.md', 'split', 'raw');
    const before = $markdownModes.get();
    setMode('/p', 'a.md', 'split', 'raw');
    expect($markdownModes.get()).to.equal(before);
  });

  it('does not touch another project’s entry', () => {
    setMode('/q', 'a.md', 'preview', 'raw');
    const before = localStorage.getItem('batrak:markdown:mode:/q');
    setMode('/p', 'a.md', 'split', 'raw');
    expect(localStorage.getItem('batrak:markdown:mode:/q')).to.equal(before);
  });

  describe('reading what was stored', () => {
    it('keeps the valid modes and drops the rest', () => {
      expect(parseModes({ 'a.md': 'split', 'b.md': 'preview', 'c.md': 'wysiwyg', 'd.md': 3, 'e.md': 'raw' })).to.deep.equal({ 'a.md': 'split', 'b.md': 'preview', 'e.md': 'raw' });
    });

    it('takes nothing but an object of files', () => {
      for (const raw of [null, 'split', 7, ['split'], undefined]) expect(parseModes(raw), JSON.stringify(raw)).to.equal(null);
    });

    it('drops an entry that is nothing but invalid', () => {
      expect(parseModes({ 'a.md': 'nope' })).to.equal(null);
    });
  });

  describe('pruning', () => {
    it('drops the entries of files that are gone', () => {
      setMode('/p', 'keep.md', 'split', 'raw');
      setMode('/p', 'gone.md', 'preview', 'raw');
      setMode('/p', 'moved.md', 'split', 'raw');

      pruneModes('/p', (rel) => rel === 'keep.md');

      expect($markdownModes.get()['/p']).to.deep.equal({ 'keep.md': 'split' });
    });

    it('forgets the project when none of its files is left', () => {
      setMode('/p', 'gone.md', 'preview', 'raw');
      pruneModes('/p', () => false);
      expect($markdownModes.get()['/p']).to.equal(undefined);
      expect(localStorage.getItem('batrak:markdown:mode:/p')).to.equal(null);
    });
  });
});
