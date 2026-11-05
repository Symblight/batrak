import { expect } from '@esm-bundle/chai';
import {
  $activePath,
  $agentsReveal,
  $editorTabs,
  $folderTabs,
  $settingsReveal,
  AGENTS_TAB_ID,
  SETTINGS_TAB_ID,
  agentsRevealed,
  closeFolderTab,
  closeTab,
  openAgents,
  openSettings,
  openTab,
  parseTabId,
  parseTabs,
  settingsRevealed,
} from '../editor.js';
import { $project } from '../../project/project.js';
import { terminalTabId } from '../../tab-ids/tab-ids.js';
import { MAIN, setActiveWorkspace, setWorkspaces } from '../../workspaces/workspaces.js';

/** @typedef {import('../../../hooks/workspaces/types.js').Workspace} Workspace */

describe('editor', () => {
  afterEach(() => {
    closeTab(SETTINGS_TAB_ID);
    closeTab(AGENTS_TAB_ID);
    $settingsReveal.set(null);
    $agentsReveal.set(null);
  });

  it('opens the Agents tab, with no project too, at its add form or an agent until it has shown it', () => {
    $project.set(null);
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

  it('keeps a stored project’s terminal tabs, and drops the old one with no terminal', () => {
    const stored = { paths: ['/p/a.js', terminalTabId('t1'), 'view:terminal'], active: terminalTabId('t1'), pinned: [] };
    expect(parseTabs(stored)).to.deep.equal({ paths: ['/p/a.js', terminalTabId('t1')], active: terminalTabId('t1'), pinned: [] });
  });

  describe('per workspace', () => {
    const WORKSPACE = /** @type {Workspace} */ ({ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/task' });

    afterEach(() => {
      setActiveWorkspace('/p', MAIN);
      setWorkspaces([]);
      $project.set(null);
      for (const key of ['/p', '/wt/task']) $folderTabs.setKey(key, undefined);
    });

    it("shows the active folder's tabs, each workspace's kept while another is shown", () => {
      // Arrange
      $project.set({ path: '/p', name: 'p', rootId: 'root-1' });
      setWorkspaces([WORKSPACE], '/p');
      openTab('/p/a.js');

      // Act
      const seen = [];
      setActiveWorkspace('/p', 'w1');
      openTab('/wt/task/b.js');
      openTab('/p/a.js');
      seen.push($editorTabs.get().paths);
      setActiveWorkspace('/p', MAIN);
      seen.push($editorTabs.get().paths);
      setActiveWorkspace('/p', 'w1');
      seen.push($editorTabs.get().paths);

      // Assert
      expect(seen, "a file outside the workspace's folder isn't its tab").to.deep.equal([['/wt/task/b.js'], ['/p/a.js'], ['/wt/task/b.js']]);
      expect(JSON.parse(localStorage.getItem('batrak:editor:tabs:/wt/task') ?? 'null')?.paths).to.include('/wt/task/b.js');
    });

    it("moves tabs of a workspace's files from its project's entry to the workspace's once it's listed", () => {
      // Arrange
      $folderTabs.setKey('/p', { paths: ['/p/a.js', '/wt/task/b.js'], active: '/wt/task/b.js', pinned: ['/wt/task/b.js'] });
      $folderTabs.setKey('/wt/task', { paths: ['/wt/task/c.js'], active: '/wt/task/c.js', pinned: [] });

      // Act
      setWorkspaces([WORKSPACE], '/p');
      setWorkspaces([WORKSPACE], '/p');

      // Assert
      expect($folderTabs.get()['/p']).to.deep.equal({ paths: ['/p/a.js'], active: '/p/a.js', pinned: [] });
      expect($folderTabs.get()['/wt/task'], 'once; the workspace keeps its own active tab').to.deep.equal({
        paths: ['/wt/task/b.js', '/wt/task/c.js'],
        active: '/wt/task/c.js',
        pinned: ['/wt/task/b.js'],
      });
    });
  });

  describe('closeFolderTab', () => {
    afterEach(() => {
      $project.set(null);
      $folderTabs.setKey('/a', undefined);
      $folderTabs.setKey('/b', undefined);
    });

    it('closes a tab of a project that isn’t shown and leaves the shown one’s alone', () => {
      $project.set({ path: '/a', name: 'a', rootId: null });
      const shared = terminalTabId('same');
      openTab('/a/x.js');
      openTab(shared);
      $folderTabs.setKey('/b', { paths: ['/b/y.js', terminalTabId('t2')], active: terminalTabId('t2'), pinned: [] });

      closeFolderTab('/b', terminalTabId('t2'));
      expect($folderTabs.get()['/b']).to.deep.equal({ paths: ['/b/y.js'], active: '/b/y.js', pinned: [] });
      expect($editorTabs.get().paths).to.deep.equal(['/a/x.js', shared]);

      closeFolderTab('/a', shared);
      expect($editorTabs.get()).to.deep.equal({ paths: ['/a/x.js'], active: '/a/x.js', pinned: [] });
    });

    it('closes a tab opened with no project', () => {
      openTab(terminalTabId('t3'));
      closeFolderTab(null, terminalTabId('t3'));
      expect($editorTabs.get().paths).to.not.include(terminalTabId('t3'));
    });
  });
});
