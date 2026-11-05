import { expect } from '@esm-bundle/chai';
import {
  $projectSearch,
  $searchDialogPrefs,
  addRecentSearch,
  parseProjectSearch,
  parseSearchDialogPrefs,
  saveProjectSearch,
  setSearchDialogPrefs,
} from '../search.js';

const STATE = { query: 'foo', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.js' };

describe('search stores', () => {
  afterEach(() => {
    for (const project of Object.keys($projectSearch.get())) $projectSearch.setKey(project, undefined);
    $searchDialogPrefs.set({ preview: 'bottom', view: 'grouped', splitBottom: 50, splitRight: 50 });
  });

  it('starts with the preview at the bottom, grouped, halves', () => {
    expect(parseSearchDialogPrefs({})).to.deep.equal({ preview: 'bottom', view: 'grouped', splitBottom: 50, splitRight: 50 });
  });

  it('validates stored prefs and clamps the splits', () => {
    expect(parseSearchDialogPrefs({ preview: 'right', view: 'flat', splitBottom: 5, splitRight: 95 })).to.deep.equal({
      preview: 'right',
      view: 'flat',
      splitBottom: 20,
      splitRight: 80,
    });
    expect(parseSearchDialogPrefs({ preview: 'left', view: 1, splitBottom: 'x', splitRight: 33 })).to.deep.equal({
      preview: 'bottom',
      view: 'grouped',
      splitBottom: 50,
      splitRight: 33,
    });
    expect(parseSearchDialogPrefs(null)).to.equal(null);
    expect(parseSearchDialogPrefs([])).to.equal(null);
  });

  it('patches the prefs, clamping the splits', () => {
    setSearchDialogPrefs({ preview: 'none' });
    setSearchDialogPrefs({ splitRight: 90 });
    expect($searchDialogPrefs.get()).to.deep.equal({ preview: 'none', view: 'grouped', splitBottom: 50, splitRight: 80 });
  });

  it("saves a project's state, keeping its recent searches", () => {
    addRecentSearch('/p', 'bar');
    saveProjectSearch('/p', STATE);
    expect($projectSearch.get()['/p']).to.deep.equal({ ...STATE, recent: ['bar'] });
    saveProjectSearch('/q', STATE);
    expect($projectSearch.get()['/q']).to.deep.equal({ ...STATE, recent: [] });
  });

  it('keeps 10 recent searches, most recent first, once each', () => {
    saveProjectSearch('/p', STATE);
    addRecentSearch('/p', '  ');
    expect($projectSearch.get()['/p']?.recent).to.deep.equal([]);
    for (let i = 0; i < 12; i++) addRecentSearch('/p', `q${i}`);
    addRecentSearch('/p', ' q5 ');
    expect($projectSearch.get()['/p']?.recent).to.deep.equal(['q5', 'q11', 'q10', 'q9', 'q8', 'q7', 'q6', 'q4', 'q3', 'q2']);
    expect($projectSearch.get()['/p']?.query, 'the state stays').to.equal('foo');
  });

  it('writes one item per project through setKey', () => {
    saveProjectSearch('/p', STATE);
    saveProjectSearch('/q', { ...STATE, query: 'baz' });
    expect(JSON.parse(localStorage.getItem('batrak:search:project:/p') ?? 'null')).to.deep.equal({ ...STATE, recent: [] });
    expect(JSON.parse(localStorage.getItem('batrak:search:project:/q') ?? 'null').query).to.equal('baz');
  });

  it("validates a stored project's state", () => {
    expect(parseProjectSearch({ query: 'x', regex: true, recent: ['a', 1, 'a', 'b'] })).to.deep.equal({
      query: 'x',
      caseSensitive: false,
      wholeWord: false,
      regex: true,
      folder: '',
      mask: '',
      recent: ['a', 'b'],
    });
    expect(parseProjectSearch('x')).to.equal(null);
  });

  it('trims stored recent searches, drops blank ones and keeps the first 10', () => {
    expect(parseProjectSearch({ recent: ['a', '', '  ', 'b'] })?.recent).to.deep.equal(['a', 'b']);
    expect(parseProjectSearch({ recent: [' a ', 'a', 'b'] })?.recent, 'trimmed like addRecentSearch, then once each').to.deep.equal(['a', 'b']);
    const many = Array.from({ length: 12 }, (_, i) => `q${i}`);
    expect(parseProjectSearch({ recent: many })?.recent).to.deep.equal(many.slice(0, 10));
  });
});
