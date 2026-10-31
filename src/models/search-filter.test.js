import { expect } from '@esm-bundle/chai';
import { filterLabel, searchFilters, splitPatterns } from './search-filter.js';

describe('search filters', () => {
  it('splits on commas outside braces, trimmed, empties dropped', () => {
    expect(splitPatterns('src/**/*.{js,ts}, !*.test.js')).to.deep.equal(['src/**/*.{js,ts}', '!*.test.js']);
    expect(splitPatterns(' *.css ,, ,*.md,')).to.deep.equal(['*.css', '*.md']);
    expect(splitPatterns('')).to.deep.equal([]);
  });

  it('matches a pattern without a slash at any depth', () => {
    expect(searchFilters('', '*.ts')).to.deep.equal({ include: '**/*.ts', exclude: '' });
    expect(searchFilters('', '*.{js,ts}')).to.deep.equal({ include: '**/*.{js,ts}', exclude: '' });
  });

  it('matches a pattern with a slash from the root', () => {
    expect(searchFilters('', 'src/**/*.{js,ts}, !*.test.js')).to.deep.equal({
      include: 'src/**/*.{js,ts}',
      exclude: '**/*.test.js',
    });
  });

  it('prefixes includes with the folder, never excludes', () => {
    expect(searchFilters('src/components', '*.ts, lib/*.js, !*.test.ts, !src/gen/**')).to.deep.equal({
      include: 'src/components/**/*.ts, src/components/lib/*.js',
      exclude: '**/*.test.ts, src/gen/**',
    });
  });

  it('includes the folder alone without an include pattern', () => {
    expect(searchFilters('src', '')).to.deep.equal({ include: 'src', exclude: '' });
    expect(searchFilters('src', '!*.md')).to.deep.equal({ include: 'src', exclude: '**/*.md' });
    expect(searchFilters('', '')).to.deep.equal({ include: '', exclude: '' });
  });

  it('labels where it searches', () => {
    expect(filterLabel('src/components', '*.ts')).to.equal('in src/components, *.ts');
    expect(filterLabel('src', '')).to.equal('in src');
    expect(filterLabel('', ' *.ts, !*.test.ts ')).to.equal('*.ts, !*.test.ts');
    expect(filterLabel('', '')).to.equal('');
  });
  it('keeps a bracket class with a comma whole', () => {
    expect(splitPatterns('a[,]b, *.md, [!,]x')).to.deep.equal(['a[,]b', '*.md', '[!,]x']);
    expect(splitPatterns('[]],x')).to.deep.equal(['[]]', 'x']);
    expect(splitPatterns('a[b,c')).to.deep.equal(['a[b', 'c']);
  });

  it('matches the folder literally, glob characters and commas included', () => {
    expect(searchFilters('app/[id]', '')).to.deep.equal({ include: 'app/[[]id[]]', exclude: '' });
    expect(searchFilters('a,b/{x}', '*.ts')).to.deep.equal({ include: 'a[,]b/[{]x[}]/**/*.ts', exclude: '' });
    expect(searchFilters('what?/*', '')).to.deep.equal({ include: 'what[?]/[*]', exclude: '' });
    expect(splitPatterns(searchFilters('a,b', '*.ts, *.js').include)).to.deep.equal(['a[,]b/**/*.ts', 'a[,]b/**/*.js']);
  });

  it('drops a leading ./ from a pattern before the folder prefix', () => {
    expect(searchFilters('src', './lib/*.js, !./gen/**')).to.deep.equal({ include: 'src/lib/*.js', exclude: 'gen/**' });
  });
});
