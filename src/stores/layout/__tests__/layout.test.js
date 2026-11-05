import { expect } from '@esm-bundle/chai';
import { $markdownSplit, MARKDOWN_SPLIT_DEFAULT, parseMarkdownSplit, setMarkdownSplit } from '../layout.js';

describe('layout: the markdown split', () => {
  afterEach(() => $markdownSplit.set(MARKDOWN_SPLIT_DEFAULT));

  it('starts at half and half', () => {
    expect($markdownSplit.get()).to.equal(50);
  });

  it('keeps the editor’s share between a fifth and four fifths, shared in storage', () => {
    setMarkdownSplit(35);
    expect($markdownSplit.get()).to.equal(35);
    expect(localStorage.getItem('brama:layout:markdown-split')).to.equal('35');

    setMarkdownSplit(5);
    expect($markdownSplit.get()).to.equal(20);
    setMarkdownSplit(99);
    expect($markdownSplit.get()).to.equal(80);
  });

  it('ignores what is no number', () => {
    setMarkdownSplit(Number.NaN);
    expect($markdownSplit.get()).to.equal(50);
  });

  it('reads a stored value clamped, and anything else as the default', () => {
    expect(parseMarkdownSplit(33)).to.equal(33);
    expect(parseMarkdownSplit(1)).to.equal(20);
    expect(parseMarkdownSplit(500)).to.equal(80);
    for (const raw of ['50', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) expect(parseMarkdownSplit(raw), String(raw)).to.equal(null);
  });
});
