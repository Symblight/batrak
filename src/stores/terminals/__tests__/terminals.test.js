import { expect } from '@esm-bundle/chai';
import { $editorTabs, $projectTabs, openTab } from '../../editor/editor.js';
import {
  $projectTerminalPanelHeights,
  $projectTerminalPanels,
  $projectTerminalTabs,
  $terminalFocus,
  $terminalPanel,
  $terminalPanelHeight,
  $terminalTabs,
  TERMINAL_PANEL_MAX_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
  $terminals,
  addSessionTerminal,
  closeTerminalTab,
  focusTerminal,
  forgetTerminal,
  openLoginTerminal,
  openTerminal,
  setTerminalPanelHeight,
  setTerminalPanelOpen,
  terminalFocused,
  terminalGroup,
  terminalExited,
  terminalStarted,
  sessionTerminalOf,
  terminalsOfProject,
} from '../terminals.js';
import { $workspace } from '../../workspace/workspace.js';
import { terminalTabId } from '../../tab-ids/tab-ids.js';

describe('terminals', () => {
  afterEach(() => {
    $terminals.set({});
    $projectTerminalTabs.set({});
    $projectTerminalPanels.set({});
    $terminalFocus.set(null);
    for (const root of ['/p', '/q', '']) $projectTerminalPanelHeights.setKey(root, undefined);
    $workspace.set(null);
    $projectTabs.setKey('/p', undefined);
    $projectTabs.setKey('', undefined);
  });

  it('opens a terminal’s tab at the end of the shown project’s panel, showing it and leaving the editor’s tabs alone', () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $projectTabs.setKey('/p', { paths: ['/p/a.js'], active: '/p/a.js', pinned: [] });
    expect($terminalPanel.get(), 'hidden until a terminal opens').to.deep.equal({ open: false });
    const first = openTerminal('/p', '/p', 'p');
    const id = openTerminal('/p/src', '/p', 'src');
    expect($terminalTabs.get()).to.deep.equal({ paths: [terminalTabId(first), terminalTabId(id)], active: terminalTabId(id), pinned: [] });
    expect($editorTabs.get().paths).to.deep.equal(['/p/a.js']);
    expect($terminalPanel.get()).to.deep.equal({ open: true });
    expect($terminals.get()[id]).to.deep.equal({
      cwd: '/p/src',
      fallback: '/p',
      label: 'src',
      title: null,
      projectPath: '/p',
      status: 'starting',
      exit: null,
      error: null,
      login: null,
    });
    expect(terminalsOfProject('/p')).to.deep.equal([first, id]);
    expect(terminalsOfProject('/q')).to.deep.equal([]);
  });

  it("opens a sign-in's login, which the backend started, as a running terminal's tab in the panel once", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    const tab = { terminalId: 'sign-in-1', title: 'Copilot Login', commandLine: '/opt/copilot login' };
    openLoginTerminal(tab, '/p');
    expect($terminals.get()['sign-in-1']).to.deep.equal({
      cwd: '',
      fallback: null,
      label: 'Copilot Login',
      title: null,
      projectPath: '/p',
      status: 'running',
      exit: null,
      error: null,
      login: '/opt/copilot login',
    });
    expect($terminalTabs.get().active).to.equal(terminalTabId('sign-in-1'));
    expect($terminalPanel.get(), 'shown').to.deep.equal({ open: true });
    openTerminal('/p', '/p', 'p');
    terminalExited('sign-in-1', { code: 1, signal: null });
    openLoginTerminal(tab, '/p');
    expect($terminalTabs.get().paths, 'once').to.have.length(2);
    expect($terminalTabs.get().active).to.equal(terminalTabId('sign-in-1'));
    expect($terminals.get()['sign-in-1'].status, 'shown again, as it is').to.equal('exited');
  });

  it('files a login in the panel of the project its sign-in started in, shown or not', () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    openLoginTerminal({ terminalId: 'sign-in-2', title: 'Login', commandLine: 'login' }, '/q');
    expect($terminals.get()['sign-in-2'].projectPath).to.equal('/q');
    expect($terminalTabs.get().paths, 'the shown project').to.deep.equal([]);
    expect($terminalPanel.get(), 'its panel stays as it was').to.deep.equal({ open: false });
    expect($projectTerminalTabs.get()['/q']).to.deep.equal({ paths: [terminalTabId('sign-in-2')], active: terminalTabId('sign-in-2'), pinned: [] });
    expect($projectTerminalPanels.get()['/q']).to.deep.equal({ open: true });
  });

  it('follows a terminal from its start to its exit, then forgets it', () => {
    const id = openTerminal('/home/me', null, 'me');
    expect($terminals.get()[id].projectPath).to.equal(null);
    terminalStarted(id, { shell: 'zsh', cwd: '/home/me' }, 'zsh — me');
    expect($terminals.get()[id]).to.include({ status: 'running', label: 'zsh — me', cwd: '/home/me' });
    terminalExited(id, { code: 1, signal: null });
    expect($terminals.get()[id]).to.deep.include({ status: 'exited', exit: { code: 1, signal: null } });
    forgetTerminal(id);
    expect($terminals.get()).to.deep.equal({});
  });

  it("keeps a session's CLI out of every project's tabs", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    addSessionTerminal('t1', 's1', '/p', 'Claude Code');
    expect($terminals.get().t1).to.include({ status: 'running', sessionId: 's1' });
    expect(sessionTerminalOf('s1')).to.equal('t1');
    expect(sessionTerminalOf('s2')).to.equal(null);
    expect($editorTabs.get().paths).to.deep.equal([]);
    expect($terminalTabs.get().paths).to.deep.equal([]);
    expect(terminalsOfProject(null)).to.deep.equal([]);
    forgetTerminal('t1');
    expect(sessionTerminalOf('s1')).to.equal(null);
  });

  it('keeps terminal tabs in a group of their own, with the editor’s rules, per project', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(terminalTabId);
    $workspace.set({ path: '/p', name: 'p', rootId: null });

    // Act + Assert: open appends and activates; close picks the neighbour
    terminalGroup.open(a);
    terminalGroup.open(b);
    terminalGroup.open(c);
    expect($terminalTabs.get()).to.deep.equal({ paths: [a, b, c], active: c, pinned: [] });
    terminalGroup.close(c);
    expect($terminalTabs.get().active).to.equal(b);

    // Act + Assert: pin moves to the front, move reorders after the pinned ones
    terminalGroup.open(c);
    terminalGroup.setPinned(c, true);
    terminalGroup.move(a, 2);
    expect($terminalTabs.get()).to.deep.equal({ paths: [c, b, a], active: c, pinned: [c] });

    // Assert: the editor's tabs are untouched, and another project has its own group
    expect($editorTabs.get().paths).to.deep.equal([]);
    terminalGroup.openIn('/q', a);
    terminalGroup.openIn('/q', b);
    terminalGroup.closeIn('/q', b);
    expect($terminalTabs.get().paths).to.deep.equal([c, b, a]);
    expect($projectTerminalTabs.get()['/q']).to.deep.equal({ paths: [a], active: a, pinned: [] });
    $workspace.set({ path: '/q', name: 'q', rootId: null });
    expect($terminalTabs.get().paths).to.deep.equal([a]);
  });

  describe('the terminal panel', () => {
    it('remembers per project whether the panel is open, and its height within limits', () => {
      // Act
      $workspace.set({ path: '/p', name: 'p', rootId: null });
      setTerminalPanelOpen('/p', true);
      setTerminalPanelHeight(10);
      setTerminalPanelHeight(NaN);
      $workspace.set({ path: '/q', name: 'q', rootId: null });
      setTerminalPanelHeight(TERMINAL_PANEL_MAX_HEIGHT + 500);
      const other = [$terminalPanel.get(), $terminalPanelHeight.get()];
      $workspace.set({ path: '/p', name: 'p', rootId: null });
      // Assert
      expect(other, 'another project has its own, clamped to the most').to.deep.equal([{ open: false }, TERMINAL_PANEL_MAX_HEIGHT]);
      expect($terminalPanel.get(), 'back as it was').to.deep.equal({ open: true });
      expect($terminalPanelHeight.get(), 'clamped to the least; a NaN changes nothing').to.equal(TERMINAL_PANEL_MIN_HEIGHT);
      expect(localStorage.getItem('brama:layout:terminal-panel:/p')).to.equal(String(TERMINAL_PANEL_MIN_HEIGHT));
    });

    it('closes a terminal’s tab wherever it is: in the panel, or in the editor’s tabs it was moved to', () => {
      // Arrange
      $workspace.set({ path: '/p', name: 'p', rootId: null });
      const inPanel = openTerminal('/p', '/p', 'p');
      const moved = openTerminal('/p', '/p', 'p');
      terminalGroup.close(terminalTabId(moved));
      openTab(terminalTabId(moved));
      // Act
      closeTerminalTab('/p', inPanel);
      closeTerminalTab('/p', moved);
      // Assert
      expect($terminalTabs.get().paths).to.deep.equal([]);
      expect($editorTabs.get().paths).to.deep.equal([]);
    });

    it('asks to focus a terminal until the view has', () => {
      focusTerminal('t1');
      const first = /** @type {NonNullable<ReturnType<typeof $terminalFocus.get>>} */ ($terminalFocus.get());
      expect(first).to.deep.equal({ terminalId: 't1' });

      focusTerminal('t1');
      terminalFocused(first);
      expect($terminalFocus.get(), 'a newer request stays').to.not.equal(null);

      terminalFocused(/** @type {NonNullable<ReturnType<typeof $terminalFocus.get>>} */ ($terminalFocus.get()));
      expect($terminalFocus.get()).to.equal(null);
    });
  });
});
