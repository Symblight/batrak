import { expect } from '@esm-bundle/chai';
import { $project } from '../../project/project.js';
import { $projectAccent, $settings, clearProjectAccent, setProjectAccentEnabled, $terminalOptionMeta, $themeAccent, resetSection, setAccent, setProjectAccent, $terminalColors, $terminalFontFamily, $terminalFontSize, parseSettings, setEditorFont, setEditorFontSize, setMarkdownScrollSync, setTerminalColors, setTerminalFont, setTerminalFontSize, setTerminalOptionMeta, setTerminalTheme } from '../settings.js';
import { DEFAULT_SETTINGS, FONT_SIZE_MAX, TERMINAL_PALETTE } from '../rules.js';

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

  it('keeps custom terminal colors only when every one is a color, as a light and dark pair', () => {
    // Arrange
    const colors = { light: TERMINAL_PALETTE, dark: { ...TERMINAL_PALETTE, background: '#000000' } };
    // Act
    const good = parseSettings({ terminalTheme: 'custom', terminalColors: colors });
    const bad = parseSettings({ terminalTheme: 'custom', terminalColors: { light: TERMINAL_PALETTE, dark: { ...TERMINAL_PALETTE, red: 'url(x)' } } });
    const missing = parseSettings({ terminalTheme: 'custom', terminalColors: { light: TERMINAL_PALETTE } });
    // Assert
    expect(good).to.deep.include({ terminalTheme: 'custom', terminalColors: colors });
    expect(bad, 'never custom with no colors').to.deep.include({ terminalTheme: 'app', terminalColors: null });
    expect(missing).to.deep.include({ terminalTheme: 'app', terminalColors: null });
  });

  it('gives the terminal colors once custom, keeping them through a switch back to the app’s', () => {
    // Act
    const app = $terminalColors.get();
    setTerminalTheme('custom');
    const seeded = $terminalColors.get();
    setTerminalColors({ light: { ...TERMINAL_PALETTE, red: '#123456' }, dark: { ...TERMINAL_PALETTE, red: '#123456' } });
    const edited = $terminalColors.get();
    setTerminalColors({ light: TERMINAL_PALETTE, dark: { ...TERMINAL_PALETTE, red: 'nope' } });
    const refused = $terminalColors.get();
    setTerminalTheme('app');
    const back = $terminalColors.get();
    setTerminalTheme('custom');
    // Assert
    expect(app).to.equal(null);
    expect(seeded).to.deep.equal({ light: TERMINAL_PALETTE, dark: TERMINAL_PALETTE });
    expect(edited?.dark.red).to.equal('#123456');
    expect(refused?.dark.red, 'not a color').to.equal('#123456');
    expect(back).to.equal(null);
    expect($terminalColors.get()?.dark.red, 'kept').to.equal('#123456');
  });

  it('reads and sets ⌥ as Meta, off unless stored as on', () => {
    expect(parseSettings({ terminalOptionMeta: true })?.terminalOptionMeta).to.equal(true);
    expect(parseSettings({ terminalOptionMeta: 'yes' })?.terminalOptionMeta).to.equal(false);
    setTerminalOptionMeta(true);
    expect($terminalOptionMeta.get()).to.equal(true);
  });

  it('sets the scroll sync', () => {
    setMarkdownScrollSync(false);
    expect($settings.get().markdownScrollSync).to.equal(false);
  });
});

describe('settings store: project accent', () => {
  /** @param {string} path */
  const show = (path) => $project.set({ path, name: path, rootId: null });

  afterEach(() => {
    for (const path of ['/a', '/b']) {
      show(path);
      clearProjectAccent();
    }
    $project.set(null);
    $settings.set(DEFAULT_SETTINGS);
  });

  it('colors a project on its own, the others and no project keeping the global accent', () => {
    // Arrange
    setAccent('#112233');
    show('/a');
    // Act
    setProjectAccent('#a0b');
    // Assert
    expect($projectAccent.get()).to.deep.equal({ color: '#AA00BB', enabled: true });
    expect($themeAccent.get()).to.equal('#AA00BB');
    show('/b');
    expect($projectAccent.get(), 'another project').to.equal(null);
    expect($themeAccent.get()).to.equal('#112233');
    $project.set(null);
    expect($themeAccent.get(), 'no project').to.equal('#112233');
    show('/a');
    expect($themeAccent.get(), 'back on the project').to.equal('#AA00BB');
  });

  it('keeps the stored color over something not a color', () => {
    // Arrange
    show('/a');
    setProjectAccent('#AA00BB');
    // Act
    setProjectAccent('nope');
    // Assert
    expect($themeAccent.get()).to.equal('#AA00BB');
  });

  it('starts from the global accent, and keeps its color while switched off', () => {
    // Arrange
    setAccent('#112233');
    show('/a');
    // Act
    setProjectAccentEnabled(true);
    // Assert
    expect($projectAccent.get(), 'first on').to.deep.equal({ color: '#112233', enabled: true });
    // Act
    setProjectAccent('#AA00BB');
    setProjectAccentEnabled(false);
    // Assert
    expect($themeAccent.get(), 'off').to.equal('#112233');
    // Act
    setAccent('#445566');
    setProjectAccentEnabled(true);
    // Assert
    expect($themeAccent.get(), 'on again').to.equal('#AA00BB');
  });

  it('is cleared with the Theme section, for the project shown only', () => {
    // Arrange
    show('/a');
    setProjectAccent('#AA00BB');
    show('/b');
    setProjectAccent('#00AA00');
    // Act
    resetSection('theme');
    // Assert
    expect($projectAccent.get()).to.equal(null);
    show('/a');
    expect($projectAccent.get()?.color, 'the other project').to.equal('#AA00BB');
  });
});
