import { expect } from '@esm-bundle/chai';
import {
  $activePath,
  $editorTabs,
  $projectTabs,
  $settingsReveal,
  SETTINGS_TAB_ID,
  closeProjectTab,
  closeTab,
  openSettings,
  openTab,
  parseTabId,
  parseTabs,
  settingsRevealed,
} from './editor.js';
import { $workspace } from './workspace.js';
import { terminalTabId } from '../models/tab-ids.js';

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

  it('tells a terminal’s tab by its prefix', () => {
    expect(parseTabId(terminalTabId('t1'))).to.deep.equal({ kind: 'terminal', path: '' });
  });

  it('forgets terminal tabs a stored project had, whose shells are gone', () => {
    const stored = { paths: ['/p/a.js', terminalTabId('t1'), 'view:terminal'], active: terminalTabId('t1'), pinned: [terminalTabId('t1')] };
    expect(parseTabs(stored)).to.deep.equal({ paths: ['/p/a.js'], active: '/p/a.js', pinned: [] });
  });

  describe('closeProjectTab', () => {
    afterEach(() => {
      $workspace.set(null);
      $projectTabs.setKey('/a', undefined);
      $projectTabs.setKey('/b', undefined);
    });

    it('closes a tab of a project that isn’t shown and leaves the shown one’s alone', () => {
      $workspace.set({ path: '/a', name: 'a', rootId: null });
      const shared = terminalTabId('same');
      openTab('/a/x.js');
      openTab(shared);
      $projectTabs.setKey('/b', { paths: ['/b/y.js', terminalTabId('t2')], active: terminalTabId('t2'), pinned: [] });

      closeProjectTab('/b', terminalTabId('t2'));
      expect($projectTabs.get()['/b']).to.deep.equal({ paths: ['/b/y.js'], active: '/b/y.js', pinned: [] });
      expect($editorTabs.get().paths).to.deep.equal(['/a/x.js', shared]);

      closeProjectTab('/a', shared);
      expect($editorTabs.get()).to.deep.equal({ paths: ['/a/x.js'], active: '/a/x.js', pinned: [] });
    });

    it('closes a tab opened with no project', () => {
      openTab(terminalTabId('t3'));
      closeProjectTab(null, terminalTabId('t3'));
      expect($editorTabs.get().paths).to.not.include(terminalTabId('t3'));
    });
  });
});
