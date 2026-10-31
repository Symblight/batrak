import { expect } from '@esm-bundle/chai';
import { search } from '../search.js';

describe('search', () => {
  it('is one frozen object whose members can be taken apart', () => {
    expect(Object.isFrozen(search)).to.equal(true);
    const { optionForKey } = search;
    expect(optionForKey({ code: 'KeyR', altKey: true, metaKey: false, ctrlKey: false })).to.equal('regex');
  });

  it('turns a folder and a mask into the backend’s include and exclude', () => {
    expect(search.filters('src', '*.ts, !*.test.ts')).to.deep.equal({ include: 'src/**/*.ts', exclude: '**/*.test.ts' });
    expect(search.filterLabel('src', '*.ts')).to.be.a('string');
  });

  it('starts a search from a short one-line selection, else the last query', () => {
    expect(search.initialQuery('  needle ', 'last')).to.equal('needle');
    expect(search.initialQuery('a\nb', 'last')).to.equal('last');
  });

  it('flattens results into rows and sums them up', () => {
    /** @type {import('../../../models/types/types.js').SearchFileResult[]} */
    const results = [{ path: 'a.js', matches: [{ line: 3, text: 'foo', offset: 0, ranges: [[0, 3]] }] }];
    expect(search.matchRows(results).length).to.be.greaterThan(0);
    expect(search.countMatches(results)).to.deep.equal({ matches: 1, files: 1 });
    expect(search.maxMatches).to.equal(2000);
    expect(search.summary({ results, searching: false, error: null, query: 'foo' })).to.be.a('string');
  });
});
