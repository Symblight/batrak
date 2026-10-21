import { expect } from '@esm-bundle/chai';
import { $activePath, $settingsReveal, SETTINGS_TAB_ID, closeTab, openSettings, settingsRevealed } from './editor.js';

describe('editor', () => {
  afterEach(() => {
    closeTab(SETTINGS_TAB_ID);
    $settingsReveal.set(null);
  });

  it('opens Settings at a section until the tab has shown it', () => {
    openSettings({ section: 'agents', addAgent: true });
    expect($activePath.get()).to.equal(SETTINGS_TAB_ID);
    const reveal = $settingsReveal.get();
    expect(reveal).to.deep.equal({ section: 'agents', addAgent: true });

    settingsRevealed({ section: 'agents', addAgent: true });
    expect($settingsReveal.get(), 'an equal but newer request stays').to.equal(reveal);
    settingsRevealed(/** @type {import('../models/types.js').SettingsReveal} */ (reveal));
    expect($settingsReveal.get()).to.equal(null);
  });

  it('opens Settings where it was without a section', () => {
    openSettings();
    expect($activePath.get()).to.equal(SETTINGS_TAB_ID);
    expect($settingsReveal.get()).to.equal(null);
  });
});
