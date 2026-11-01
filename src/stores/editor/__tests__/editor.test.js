import { expect } from '@esm-bundle/chai';
import {
  $activePath,
  $agentsReveal,
  $editorTabs,
  $projectTabs,
  $settingsReveal,
  AGENTS_TAB_ID,
  SETTINGS_TAB_ID,
  agentsRevealed,
  closeProjectTab,
  closeTab,
  openAgents,
  openSettings,
  openTab,
  parseTabId,
  parseTabs,
  settingsRevealed,
} from '../editor.js';
import { $workspace } from '../../workspace/workspace.js';
import { terminalTabId } from '../../tab-ids/tab-ids.js';

describe('editor', () => {
  afterEach(() => {
    closeTab(SETTINGS_TAB_ID);
    closeTab(AGENTS_TAB_ID);
    $settingsReveal.set(null);
    $agentsReveal.set(null);
  });

  it('opens the Agents tab, with no project too, at its add form or an agent until it has shown it', () => {
    $workspace.set(null);
    openAgents({ add: true });
    expect($activePath.get()).to.equal(AGENTS_TAB_ID);
    expect(parseTabId(AGENTS_TAB_ID)).to.deep.equal({ kind: 'agents', path: '' });
    const reveal = $agentsReveal.get();
    expect(reveal).to.deep.equal({ add: true });

    agentsRevealed({ add: true });
    expect($agentsReveal.get(), 'an equal but newer request stays').to.equal(reveal);
    agentsRevealed(/** @type {import('../../../hooks/agents/types.js').AgentsReveal} */ (reveal));
    expect($agentsReveal.get()).to.equal(null);

    openAgents();
    expect($agentsReveal.get(), 'no reveal: where it was').to.equal(null);
    expect(parseTabs({ paths: [AGENTS_TAB_ID], active: AGENTS_TAB_ID, pinned: [] })?.paths).to.deep.equal([AGENTS_TAB_ID], 'kept with the other view tabs');
  });

  it('opens Settings at a section until the tab has shown it', () => {
    openSettings({ section: 'editor' });
    expect($activePath.get()).to.equal(SETTINGS_TAB_ID);
    const reveal = $settingsReveal.get();
    expect(reveal).to.deep.equal({ section: 'editor' });

    settingsRevealed({ section: 'editor' });
    expect($settingsReveal.get(), 'an equal but newer request stays').to.equal(reveal);
    settingsRevealed(/** @type {import('../../../hooks/settings/types.js').SettingsReveal} */ (reveal));
    expect($settingsReveal.get()).to.equal(null);
  });

  it('opens Settings where it was without a section', () => {
    openSettings();
    expect($activePath.get()).to.equal(SETTINGS_TAB_ID);
    expect($settingsReveal.get()).to.equal(null);
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
