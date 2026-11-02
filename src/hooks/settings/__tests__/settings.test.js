import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect } from '@esm-bundle/chai';
import { $systemFonts } from '../../../stores/fonts/fonts.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $settings } from '../../../stores/settings/settings.js';
import { settings } from '../settings.js';

describe('settings', () => {
  afterEach(() => clearMocks());

  describe('rules', () => {
    it('starts from the system scheme, a blue accent and a 13px editor font', () => {
      expect(settings.defaults).to.deep.equal({
        appearance: 'system',
        accent: '#4355B9',
        editorFont: null,
        editorFontSize: 13,
        markdownDefaultView: 'raw',
        markdownScrollSync: true,
      });
      expect([settings.fontSizeMin, settings.fontSizeMax]).to.deep.equal([10, 24]);
    });

    it('reads a hex colour in either length and any case, or says it is not one', () => {
      expect(settings.normalizeHex('#4355b9')).to.equal('#4355B9');
      expect(settings.normalizeHex(' abc ')).to.equal('#AABBCC');
      expect(settings.normalizeHex('#12')).to.equal(null);
      expect(settings.normalizeHex('blue')).to.equal(null);
    });

    it('sets the line height at one and a half times the font size, rounded', () => {
      expect(settings.lineHeightFor(13)).to.equal(20);
      expect(settings.lineHeightFor(10)).to.equal(15);
    });

    it('stacks the editor font over the app’s monospace one, in case it is gone', () => {
      expect(settings.fontStack('Fira Code')).to.equal('"Fira Code", var(--acp-font-family-mono)');
      expect(settings.defaultEditorFont).to.equal('Google Sans Code');
    });

    it('tells whether a section is still at its defaults', () => {
      const d = settings.defaults;
      expect(settings.isSectionDefault(d, 'theme')).to.equal(true);
      expect(settings.isSectionDefault({ ...d, accent: '#000000' }, 'theme')).to.equal(false);
      expect(settings.isSectionDefault({ ...d, accent: '#000000' }, 'editor')).to.equal(true);
      expect(settings.isSectionDefault({ ...d, editorFontSize: 16 }, 'editor')).to.equal(false);
    });
  });

  describe('theme', () => {
    it('applies the chosen scheme to the page, and follows later changes', () => {
      $settings.set({ ...settings.defaults, appearance: 'dark' });
      settings.syncTheme();
      expect(document.documentElement.dataset.theme).to.equal('dark');
      expect(document.documentElement.style.colorScheme).to.equal('dark');
      $settings.set({ ...settings.defaults, appearance: 'light' });
      expect(document.documentElement.dataset.theme).to.equal('light');
      $settings.set({ ...settings.defaults, appearance: 'light', accent: '#AA0000' });
      expect(document.documentElement.dataset.theme).to.equal('light');
    });
  });

  describe('system fonts', () => {
    beforeEach(() => {
      $systemFonts.set(null);
      $notices.set([]);
    });

    it('lists the installed fonts by name, once per window', async () => {
      let asked = 0;
      mockIPC((cmd) => {
        if (cmd === 'list_fonts') {
          asked++;
          return [{ family: 'Zed Mono' }, { family: 'Arial' }];
        }
        return null;
      });
      await settings.loadSystemFonts();
      await settings.loadSystemFonts();
      expect($systemFonts.get()?.map((f) => f.family)).to.deep.equal(['Arial', 'Zed Mono']);
      expect(asked).to.equal(1);
    });
  });
});
