import { expect } from '@esm-bundle/chai';
import { $settings, parseSettings, setMarkdownScrollSync } from '../settings.js';
import { DEFAULT_SETTINGS } from '../rules.js';

describe('settings store: markdown', () => {
  afterEach(() => $settings.set(DEFAULT_SETTINGS));

  it('opens markdown files in the editor, scrolling the two together', () => {
    expect(DEFAULT_SETTINGS.markdownDefaultView).to.equal('raw');
    expect(DEFAULT_SETTINGS.markdownScrollSync).to.equal(true);
  });

  it('reads each stored field on its own, an unknown view as the editor', () => {
    expect(parseSettings({ markdownDefaultView: 'preview', markdownScrollSync: false })).to.include({ markdownDefaultView: 'preview', markdownScrollSync: false });
    expect(parseSettings({ markdownDefaultView: 'wysiwyg', markdownScrollSync: 'no', appearance: 'dark' })).to.include({
      markdownDefaultView: 'raw',
      markdownScrollSync: true,
      appearance: 'dark',
    });
    // Settings stored before the markdown keys existed.
    expect(parseSettings({ appearance: 'light', accent: '#112233', editorFont: null, editorFontSize: 14 })).to.deep.equal({
      ...DEFAULT_SETTINGS,
      appearance: 'light',
      accent: '#112233',
      editorFontSize: 14,
    });
  });

  it('sets the scroll sync', () => {
    setMarkdownScrollSync(false);
    expect($settings.get().markdownScrollSync).to.equal(false);
  });
});
