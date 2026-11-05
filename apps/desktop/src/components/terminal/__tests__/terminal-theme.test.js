import { expect } from '@esm-bundle/chai';
import { terminalTheme } from '../terminal-theme.js';

const tokens = { background: '#111111', foreground: '#eeeeee', primary: '#336699' };
const palette = { background: '#001122', foreground: '#ddeeff', cursor: '#FF0000', black: '#010101', red: '#020202', green: '#030303', yellow: '#040404', blue: '#050505', magenta: '#060606', cyan: '#070707', white: '#080808', brightBlack: '#090909', brightRed: '#0A0A0A', brightGreen: '#0B0B0B', brightYellow: '#0C0C0C', brightBlue: '#0D0D0D', brightMagenta: '#0E0E0E', brightCyan: '#0F0F0F', brightWhite: '#101010' };

describe('terminalTheme', () => {
  it('follows the app’s tokens and scheme, until a palette takes over all of it', () => {
    // Act
    const light = terminalTheme(tokens, false);
    const dark = terminalTheme(tokens, true);
    const custom = terminalTheme(tokens, true, palette);
    // Assert
    expect(light).to.include({ background: '#111111', foreground: '#eeeeee', cursor: '#336699', selectionBackground: 'rgba(51, 102, 153, 0.3)' });
    expect(light.brightWhite, 'each scheme has its ANSI colors').to.not.equal(dark.brightWhite);
    expect(custom).to.include(palette);
    expect(custom).to.include({ cursorAccent: '#001122', selectionBackground: 'rgba(255, 0, 0, 0.3)' });
    expect(custom.scrollbarSliderBackground, 'the scrollbar shows on its background').to.equal('rgba(221, 238, 255, 0.2)');
  });
});
