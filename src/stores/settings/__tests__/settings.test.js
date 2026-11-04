import { expect } from '@esm-bundle/chai';
import { $settings, $terminalFontFamily, $terminalFontSize, parseSettings, setEditorFont, setEditorFontSize, setMarkdownScrollSync, setTerminalFont, setTerminalFontSize } from '../settings.js';
import { DEFAULT_SETTINGS, FONT_SIZE_MAX } from '../rules.js';

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

  it('reads the terminal’s font and size, anything else as the editor’s', () => {
    expect(parseSettings({ terminalFont: 'Fira Code', terminalFontSize: 15 })).to.include({ terminalFont: 'Fira Code', terminalFontSize: 15 });
    expect(parseSettings({ terminalFont: '', terminalFontSize: 999 })).to.include({ terminalFont: null, terminalFontSize: null });
  });

  it('gives the terminal the editor’s font and size until it has its own', () => {
    // Arrange
    const saved = $settings.get();
    setEditorFont('Mono');
    setEditorFontSize(14);
    const inherited = [$terminalFontFamily.get(), $terminalFontSize.get()];
    // Act
    setTerminalFont('Fira Code');
    setTerminalFontSize(999);
    const own = [$terminalFontFamily.get(), $terminalFontSize.get()];
    setTerminalFont(null);
    setTerminalFontSize(null);
    const back = [$terminalFontFamily.get(), $terminalFontSize.get()];
    $settings.set(saved);
    // Assert
    expect(inherited).to.deep.equal(['Mono', 14]);
    expect(own, 'clamped').to.deep.equal(['Fira Code', FONT_SIZE_MAX]);
    expect(back).to.deep.equal(['Mono', 14]);
  });

  it('sets the scroll sync', () => {
    setMarkdownScrollSync(false);
    expect($settings.get().markdownScrollSync).to.equal(false);
  });
});
