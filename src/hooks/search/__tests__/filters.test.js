import { expect } from '@esm-bundle/chai';
import { filterLabel, searchFilters, splitPatterns } from '../filters.js';

describe('search filters', () => {
  it('splits a mask on commas outside braces and bracket classes, trimmed, empties dropped', () => {
    const cases = [
      // [mask, patterns]
      ['src/**/*.{js,ts}, !*.test.js', ['src/**/*.{js,ts}', '!*.test.js']],
      [' *.css ,, ,*.md,', ['*.css', '*.md']],
      ['', []],
      ['a[,]b, *.md, [!,]x', ['a[,]b', '*.md', '[!,]x']],
      ['[]],x', ['[]]', 'x']],
      ['a[b,c', ['a[b', 'c']],
    ];
    for (const [mask, patterns] of cases) {
      // Act + Assert
      expect(splitPatterns(/** @type {string} */ (mask)), JSON.stringify(mask)).to.deep.equal(patterns);
    }
  });

  it('turns a folder and a mask into the backend’s include and exclude', () => {
    const cases = [
      // [folder, mask, include, exclude, why]
      ['', '*.ts', '**/*.ts', '', 'no slash: any depth'],
      ['', '*.{js,ts}', '**/*.{js,ts}', '', 'braces stay whole'],
      ['', 'src/**/*.{js,ts}, !*.test.js', 'src/**/*.{js,ts}', '**/*.test.js', 'a slash: from the root'],
      ['src/components', '*.ts, lib/*.js, !*.test.ts, !src/gen/**', 'src/components/**/*.ts, src/components/lib/*.js', '**/*.test.ts, src/gen/**', 'includes go in the folder, excludes never'],
      ['src', '', 'src', '', 'the folder alone'],
      ['src', '!*.md', 'src', '**/*.md', 'only excludes: the folder alone is the include'],
      ['', '', '', '', 'nothing'],
      ['app/[id]', '', 'app/[[]id[]]', '', 'the folder literally'],
      ['a,b/{x}', '*.ts', 'a[,]b/[{]x[}]/**/*.ts', '', 'commas and braces of the folder'],
      ['what?/*', '', 'what[?]/[*]', '', 'wildcards of the folder'],
      ['src', './lib/*.js, !./gen/**', 'src/lib/*.js', 'gen/**', 'a leading ./ goes'],
    ];
    for (const [folder, mask, include, exclude, why] of cases) {
      // Act + Assert
      expect(searchFilters(folder, mask), why).to.deep.equal({ include, exclude });
    }
    expect(splitPatterns(searchFilters('a,b', '*.ts, *.js').include), 'a folder comma never splits the includes').to.deep.equal(['a[,]b/**/*.ts', 'a[,]b/**/*.js']);
  });

  it('labels where it searches', () => {
    expect(filterLabel('src/components', '*.ts')).to.equal('in src/components, *.ts');
    expect(filterLabel('src', '')).to.equal('in src');
    expect(filterLabel('', ' *.ts, !*.test.ts ')).to.equal('*.ts, !*.test.ts');
    expect(filterLabel('', '')).to.equal('');
  });
});
