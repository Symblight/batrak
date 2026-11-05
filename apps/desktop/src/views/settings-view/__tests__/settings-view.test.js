import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $systemFonts } from '../../../stores/fonts/fonts.js';
import { $project } from '../../../stores/project/project.js';
import { $projectAccent, $settings, clearProjectAccent } from '../../../stores/settings/settings.js';
import { $settingsReveal, activateTab, closeTab, openAgents, openSettings, SETTINGS_TAB_ID, AGENTS_TAB_ID } from '../../../stores/editor/editor.js';
import { settings as settingsHook } from '../../../hooks/settings/settings.js';
import '../settings-view.js';

/** @typedef {import('../settings-view.js').AcpSettingsView} AcpSettingsView */

/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('acp-settings-view', () => {
  /** @type {string[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    $settings.set(settingsHook.defaults);
    $systemFonts.set(null);
    $settingsReveal.set(null);
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === 'list_fonts') return [{ family: 'Zed Mono', monospace: true }, { family: 'Ab Mono', monospace: true }];
      return null;
    });
  });

  afterEach(() => {
    closeTab(SETTINGS_TAB_ID);
    closeTab(AGENTS_TAB_ID);
    $settings.set(settingsHook.defaults);
    clearMocks();
  });

  /** @returns {Promise<{ el: AcpSettingsView, settings: HTMLElementTagNameMap['acp-settings'] }>} */
  async function render() {
    const el = /** @type {AcpSettingsView} */ (await fixture(html`<acp-settings-view></acp-settings-view>`));
    return { el, settings: /** @type {HTMLElementTagNameMap['acp-settings']} */ (el.querySelector('acp-settings')) };
  }

  /**
   * @param {Element} from
   * @param {string} type
   * @param {object} detail
   */
  function fire(from, type, detail) {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  it('gives the settings the project shown, and sets its accent', async () => {
    // Arrange
    $project.set({ path: '/view-project', name: 'Batrak', rootId: null });
    const el = /** @type {AcpSettingsView} */ (await fixture(html`<acp-settings-view></acp-settings-view>`));
    const settings = /** @type {HTMLElementTagNameMap['acp-settings']} */ (el.querySelector('acp-settings'));
    expect(settings.projectName).to.equal('Batrak');
    // Act
    settings.dispatchEvent(new CustomEvent('acp-settings-project-accent', { detail: { accent: '#AA00BB' }, bubbles: true, composed: true }));
    await settings.updateComplete;
    // Assert
    expect(settings.projectAccent).to.deep.equal({ color: '#AA00BB', enabled: true });
    // Act
    settings.dispatchEvent(new CustomEvent('acp-settings-project-accent-enabled', { detail: { enabled: false }, bubbles: true, composed: true }));
    await settings.updateComplete;
    // Assert
    expect($projectAccent.get()).to.deep.equal({ color: '#AA00BB', enabled: false });
    // Clean up
    clearProjectAccent();
    $project.set(null);
  });

  it('shows the settings, the fonts and the section to reveal, and clears the reveal once shown', async () => {
    // Arrange
    const { el, settings } = await render();
    /** @type {Event[]} */
    const leaked = [];
    el.addEventListener('acp-settings-revealed', (e) => leaked.push(e));
    // Act
    $systemFonts.set([{ family: 'Mono', monospace: true }]);
    const reveal = { section: 'editor' };
    $settingsReveal.set(/** @type {never} */ (reveal));
    await el.updateComplete;
    // Assert
    expect(settings.settings).to.equal($settings.get());
    expect(settings.fonts).to.deep.equal([{ family: 'Mono', monospace: true }]);
    expect(settings.reveal === reveal, 'the reveal is passed on').to.equal(true);
    await until(() => $settingsReveal.get() === null);
    expect(leaked, 'handled here').to.deep.equal([]);
  });

  it('writes a change to the settings (the font size clamped) and resets a section, without the event leaving', async () => {
    // Arrange
    const { el, settings } = await render();
    /** @type {Event[]} */
    const leaked = [];
    for (const type of ['acp-settings-change', 'acp-settings-reset']) el.addEventListener(type, (e) => leaked.push(e));
    // Act
    fire(settings, 'acp-settings-change', { patch: { appearance: 'dark', accent: '#336699', editorFont: 'Mono', editorFontSize: 999, markdownScrollSync: false, terminalFont: 'Fira', terminalFontSize: 15, terminalTheme: 'custom', terminalOptionMeta: true } });
    fire(settings, 'acp-settings-change', { patch: { terminalColors: { light: settingsHook.terminalPalette, dark: { ...settingsHook.terminalPalette, red: '#123456' } } } });
    const changed = $settings.get();
    fire(settings, 'acp-settings-reset', { section: 'editor' });
    // Assert
    expect([changed.appearance, changed.accent, changed.editorFont]).to.deep.equal(['dark', '#336699', 'Mono']);
    expect(changed.editorFontSize).to.equal(settingsHook.fontSizeMax);
    expect(changed.markdownScrollSync, 'markdown').to.equal(false);
    expect([changed.terminalFont, changed.terminalFontSize], 'terminal').to.deep.equal(['Fira', 15]);
    expect(changed.terminalOptionMeta, '⌥ as Meta').to.equal(true);
    expect([changed.terminalTheme, changed.terminalColors?.dark.red], 'terminal colors').to.deep.equal(['custom', '#123456']);
    expect($settings.get().editorFont, 'the editor section is reset').to.equal(settingsHook.defaults.editorFont);
    expect($settings.get().markdownScrollSync, 'markdown too').to.equal(true);
    expect($settings.get().appearance, 'other sections are kept').to.equal('dark');
    expect($settings.get().terminalFont, 'the terminal section too').to.equal('Fira');
    expect(leaked).to.deep.equal([]);
  });

  it('lists the fonts and refreshes the agents when the Settings tab becomes the active one, or is shown while it is', async () => {
    // Arrange
    openSettings();
    openAgents();
    await render();
    // Assert
    expect([calls.includes('list_fonts'), calls.includes('agents_list')], 'not active').to.deep.equal([false, false]);
    // Act
    activateTab(SETTINGS_TAB_ID);
    await until(() => $systemFonts.get() !== null);
    // Assert
    expect($systemFonts.get()?.map((f) => f.family)).to.deep.equal(['Ab Mono', 'Zed Mono']);
    expect(calls.filter((c) => c === 'agents_list')).to.have.length(1);
    // Act: a view that comes up while Settings is the active tab
    await render();
    // Assert
    expect(calls.filter((c) => c === 'agents_list'), 'asked again').to.have.length(2);
  });
});
