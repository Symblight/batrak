import { expect } from '@esm-bundle/chai';
import { $editorTabs, $projectTabs } from '../../editor/editor.js';
import {
  $terminals,
  addSessionTerminal,
  forgetTerminal,
  openLoginTerminal,
  openTerminal,
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
    $workspace.set(null);
    $projectTabs.setKey('/p', undefined);
    $projectTabs.setKey('', undefined);
  });

  it('opens a terminal’s tab at the end of the strip, in the shown project', () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $projectTabs.setKey('/p', { paths: ['/p/a.js'], active: '/p/a.js', pinned: [] });
    const id = openTerminal('/p/src', '/p', 'src');
    expect($editorTabs.get()).to.deep.equal({ paths: ['/p/a.js', terminalTabId(id)], active: terminalTabId(id), pinned: [] });
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
    expect(terminalsOfProject('/p')).to.deep.equal([id]);
    expect(terminalsOfProject('/q')).to.deep.equal([]);
  });

  it("opens a sign-in's login, which the backend started, as a running terminal's tab once", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $projectTabs.setKey('/p', { paths: ['/p/a.js'], active: '/p/a.js', pinned: [] });
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
    expect($editorTabs.get().active).to.equal(terminalTabId('sign-in-1'));
    $projectTabs.setKey('/p', { paths: ['/p/a.js', terminalTabId('sign-in-1')], active: '/p/a.js', pinned: [] });
    terminalExited('sign-in-1', { code: 1, signal: null });
    openLoginTerminal(tab, '/p');
    expect($editorTabs.get()).to.deep.equal({ paths: ['/p/a.js', terminalTabId('sign-in-1')], active: terminalTabId('sign-in-1'), pinned: [] });
    expect($terminals.get()['sign-in-1'].status, 'shown again, as it is').to.equal('exited');
  });

  it("files a login among the tabs of the project its sign-in started in, shown or not", () => {
    $workspace.set({ path: '/p', name: 'p', rootId: null });
    $projectTabs.setKey('/p', { paths: ['/p/a.js'], active: '/p/a.js', pinned: [] });
    openLoginTerminal({ terminalId: 'sign-in-2', title: 'Login', commandLine: 'login' }, '/q');
    expect($terminals.get()['sign-in-2'].projectPath).to.equal('/q');
    expect($editorTabs.get().paths, 'the shown project').to.deep.equal(['/p/a.js']);
    expect($projectTabs.get()['/q']).to.deep.equal({ paths: [terminalTabId('sign-in-2')], active: terminalTabId('sign-in-2'), pinned: [] });
    $projectTabs.setKey('/q', undefined);
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
    $projectTabs.setKey('/p', { paths: [], active: null, pinned: [] });
    addSessionTerminal('t1', 's1', '/p', 'Claude Code');
    expect($terminals.get().t1).to.include({ status: 'running', sessionId: 's1' });
    expect(sessionTerminalOf('s1')).to.equal('t1');
    expect(sessionTerminalOf('s2')).to.equal(null);
    expect($editorTabs.get().paths).to.deep.equal([]);
    expect(terminalsOfProject(null)).to.deep.equal([]);
    forgetTerminal('t1');
    expect(sessionTerminalOf('s1')).to.equal(null);
  });
});
