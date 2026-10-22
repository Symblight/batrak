import { expect } from '@esm-bundle/chai';
import { $editorTabs, $projectTabs } from './editor.js';
import {
  $terminals,
  forgetTerminal,
  openLoginTerminal,
  openTerminal,
  terminalExited,
  terminalStarted,
  terminalsOfProject,
} from './terminals.js';
import { $workspace } from './workspace.js';
import { terminalTabId } from '../models/tab-ids.js';

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
    openLoginTerminal(tab);
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
    openLoginTerminal(tab);
    expect($editorTabs.get()).to.deep.equal({ paths: ['/p/a.js', terminalTabId('sign-in-1')], active: terminalTabId('sign-in-1'), pinned: [] });
    expect($terminals.get()['sign-in-1'].status, 'shown again, as it is').to.equal('exited');
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
});
