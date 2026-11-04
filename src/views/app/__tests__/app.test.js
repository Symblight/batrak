import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projectSearch } from '../../../stores/search/search.js';
import { $columnWidths, $hiddenColumns } from '../../../stores/layout/layout.js';
import { $projects } from '../../../stores/projects/projects.js';
import { $openRoots, $project } from '../../../stores/project/project.js';
import { $activeRoot, $activeWorkspaceId, $workspaces, setActiveWorkspace } from '../../../stores/workspaces/workspaces.js';
import { tabs } from '../../../hooks/tabs/tabs.js';
import { $sessionReads, $unreadSessions } from '../../../stores/session-read/session-read.js';
import { $activeSessionId, $draftSessions, $sessions, $sessionsLoaded, selectSession } from '../../../stores/sessions/sessions.js';
import { $editorTabs, closeAllTabs, openTab } from '../../../stores/editor/editor.js';
import {
  $folderTerminalPanelHeights,
  $folderTerminalPanels,
  $folderTerminalTabs,
  $terminalPanel,
  $terminalPanelHeight,
  $terminalTabs,
  $terminals,
  forgetTerminal,
  openTerminal,
  setTerminalPanelHeight,
  setTerminalPanelOpen,
} from '../../../stores/terminals/terminals.js';
import { app as appHook } from '../../../hooks/app/app.js';
import { codeOf } from '../../../hooks/shortcuts/keys.js';
import { composerOf } from '../../../stores/composer/composer.js';
import '../app.js';

/** @typedef {import('../app.js').AcpApp} AcpApp */
/** @typedef {import('../../../hooks/search/types.js').SearchDialogState} SearchDialogState */

/** @type {SearchDialogState} */
const STATE = { query: 'needle', caseSensitive: true, wholeWord: false, regex: false, folder: 'src', mask: '*.ts' };

/**
 * Polls until `pred` holds; fails after 2s.
 * @param {() => boolean} pred
 */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The platform's Mod (⌘ on macOS, Ctrl elsewhere), and the modifier that is not it. */
const MOD = appHook.platform === 'mac' ? 'metaKey' : 'ctrlKey';
const NOT_MOD = MOD === 'metaKey' ? 'ctrlKey' : 'metaKey';

/**
 * A key with Mod held, at its US position.
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 * @returns {KeyboardEventInit}
 */
const modKey = (key, init = {}) => ({ key, code: codeOf(key) ?? '', [MOD]: true, bubbles: true, composed: true, cancelable: true, ...init });

/**
 * A shortcut pressed anywhere in the window.
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function shortcut(key, init = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', modKey(key, init)));
}

/** @param {AcpApp} app */
const searchDialog = (app) => /** @type {HTMLElementTagNameMap['acp-search-dialog']} */ (app.querySelector('acp-search-dialog'));
/** @param {AcpApp} app */
const quickOpen = (app) => /** @type {HTMLElementTagNameMap['acp-quick-open']} */ (app.querySelector('acp-quick-open'));
/** @param {AcpApp} app */
const mainColumn = (app) => /** @type {HTMLElementTagNameMap['acp-main-column']} */ (app.querySelector('acp-main-column'));
/** @param {AcpApp} app */
const fileColumn = (app) => /** @type {HTMLElementTagNameMap['acp-file-column']} */ (app.querySelector('acp-file-column'));

/**
 * Fires one of the dialog's events, as the dialog would.
 * @param {AcpApp} app
 * @param {string} type
 * @param {object} detail
 */
function fire(app, type, detail) {
  searchDialog(app).dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/**
 * An empty answer for the commands `<acp-app>` sends as it starts: lists, the agent list and a sync report are empty,
 * the rest `null`.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function startupAnswer(cmd, args) {
  if (cmd === 'sessions_sync') return { projectPath: args.projectPath, startedAt: '', endedAt: '', agents: [] };
  if (cmd === 'agents_list') return { agents: [], defaultAgent: null, known: [], userAgents: [], errors: [] };
  return cmd.startsWith('list_') ? [] : null;
}

describe('acp-app: search dialog', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string, args: Record<string, unknown>) => unknown} A test's own answers; `undefined` falls back to `startupAnswer`. */
  let answer;

  beforeEach(() => {
    calls = [];
    answer = () => undefined;
    // Startup (sessions, git, terminals, agents…) gets empty answers; the search commands are checked.
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      return answer(cmd, a) ?? startupAnswer(cmd, a);
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $projectSearch.setKey('/p', { ...STATE, recent: ['older'] });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    for (const el of document.querySelectorAll('acp-app')) searchDialog(/** @type {AcpApp} */ (el))?.close();
    $projectSearch.setKey('/p', undefined);
    $project.set(null);
    clearMocks();
  });

  async function render() {
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await searchDialog(app).updateComplete;
    return app;
  }

  it("opens on Mod+Shift+F with the project's last search, not the side pane", async () => {
    const app = await render();
    shortcut('F', { shiftKey: true });
    await until(() => searchDialog(app).open);
    const dialog = searchDialog(app);
    expect(app.sideView).to.equal('files');
    expect(dialog.hasProject).to.equal(true);
    expect(dialog.query).to.equal('needle');
    expect(dialog.folder).to.equal('src');
    expect(dialog.mask).to.equal('*.ts');
    expect(dialog.caseSensitive).to.equal(true);
    expect(dialog.recent).to.deep.equal(['older']);
  });

  it('ignores the other shortcuts while the dialog is open', async () => {
    const app = await render();
    shortcut('F', { shiftKey: true });
    await until(() => searchDialog(app).open);
    shortcut('p');
    await app.updateComplete;
    expect(quickOpen(app).shadowRoot?.querySelector('dialog')?.open ?? false).to.equal(false);
  });

  it('opens a match from the dialog in its tab, selected', async () => {
    const app = await render();
    /** @type {unknown[][]} */
    const opened = [];
    mainColumn(app).openFile = (...args) => void opened.push(args);
    fire(app, 'acp-search-dialog-open', { path: 'src/a.ts', line: 3, column: 7, length: 3, state: { ...STATE, query: 'foo' } });
    expect(opened).to.deep.equal([['/p/src/a.ts', { line: 3, column: 7, length: 3 }]]);
  });

  it('shows the Search pane with the dialog’s search on popout', async () => {
    const app = await render();
    /** @type {unknown[]} */
    const shown = [];
    fileColumn(app).showSearch = async (state) => void shown.push(state);
    fire(app, 'acp-search-dialog-popout', { state: { ...STATE, query: 'bar' } });
    await app.updateComplete;
    expect(app.sideView).to.equal('search');
    expect(shown).to.deep.equal([{ ...STATE, query: 'bar' }]);
  });
});

describe('acp-app: the shown workspace', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      if (cmd === 'workspaces_list') return [{ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/one', branch: 'brama/task', creating: false, missing: false, error: null }];
      if (cmd === 'workspace_delete_preview') return { uncommitted: 0, commits: 1, working: [] };
      return startupAnswer(cmd, a);
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $projectSearch.setKey('/p', { ...STATE, recent: [] });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    for (const el of document.querySelectorAll('acp-app')) searchDialog(/** @type {AcpApp} */ (el))?.close();
    setActiveWorkspace('/p', 'main');
    selectSession(null);
    $draftSessions.set({});
    $sessions.set([]);
    $workspaces.set([]);
    $openRoots.set({});
    $projectSearch.setKey('/p', undefined);
    $project.set(null);
    clearMocks();
  });

  it("queries its root in Quick Open and Find in Files, opens matches in its folder, and shows its branch", async () => {
    // Arrange
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $workspaces.get().length === 1);
    /** @type {unknown[][]} */
    const opened = [];
    mainColumn(app).openFile = (...args) => void opened.push(args);
    const asked = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args.rootId);

    // Act: show a chat of the workspace, whose root is open
    $openRoots.set({ '/wt/one': 'r-w' });
    $sessions.set(/** @type {import('../../../hooks/sessions/types.js').Session[]} */ (/** @type {unknown} */ ([{ id: 'c', projectId: '/p', workspaceId: 'w1', status: 'stopped' }])));
    selectSession('c');
    quickOpen(app).dispatchEvent(new CustomEvent('acp-quick-open-query', { detail: { query: 'a' }, bubbles: true, composed: true }));
    shortcut('F', { shiftKey: true });
    await until(() => asked('find_in_files').length > 0 && asked('quick_open').length > 0);
    fire(app, 'acp-search-dialog-open', { path: 'src/a.ts', line: 1, column: 1, length: 1, state: STATE });

    // Assert
    expect(asked('quick_open')).to.deep.equal(['r-w']);
    expect(asked('find_in_files')).to.deep.equal(['r-w']);
    expect(opened[0]?.[0], 'a match is its folder’s file').to.equal('/wt/one/src/a.ts');
    await until(() => asked('git_head').includes('r-w'));
  });
});

describe('acp-app: switching, creating and deleting workspaces', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      if (cmd === 'workspaces_list') return [{ id: 'w1', projectPath: '/p', name: 'Task', folder: '/wt/one', branch: 'brama/task', createdAt: '2026-01-01T00:00:00.000Z', creating: false, missing: false, error: null }];
      if (cmd === 'workspace_create') return { id: 'w2', projectPath: '/p', name: 'Workspace', nameSource: 'agent', folder: '/wt/two', branch: 'brama/workspace', createdAt: '2026-01-02T00:00:00.000Z', creating: true, missing: false, error: null };
      if (cmd === 'workspace_delete_preview') return { uncommitted: 0, commits: 1, working: [] };
      if (cmd === 'git_branches') return { local: a.rootId === 'r' ? ['main', 'dev'] : ['brama/task'], remotes: [], default: null };
      if (cmd === 'git_head') return { branch: a.rootId === 'r' ? 'main' : 'brama/task', sha: 'abc', detached: false, upstream: null, ahead: 0, behind: 0, upstreamSha: null, remote: null };
      return startupAnswer(cmd, a);
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    setActiveWorkspace('/p', 'main');
    selectSession(null);
    $draftSessions.set({});
    $sessions.set([]);
    $workspaces.set([]);
    $project.set(null);
    clearMocks();
  });

  /** The app with its workspaces listed, and a way to fire the toolbar's events. */
  async function render() {
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $sessionsLoaded.get() && $workspaces.get().length === 1);
    $sessions.set(/** @type {import('../../../hooks/sessions/types.js').Session[]} */ (/** @type {unknown} */ ([
      { id: 'm', projectId: '/p', workspaceId: null, folder: '/p', status: 'stopped', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c', projectId: '/p', workspaceId: 'w1', folder: '/wt/one', status: 'stopped', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' },
    ])));
    selectSession('m');
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (app.querySelector('acp-toolbar'));
    /** @param {string} type @param {unknown} [detail] */
    const fire = (type, detail = null) => toolbar.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    return { app, fire };
  }

  /** The workspace of the shown chat or draft. */
  const shownChatWorkspace = () => {
    const id = /** @type {string} */ ($activeSessionId.get());
    return $sessions.get().find((s) => s.id === id)?.workspaceId ?? $draftSessions.get()[id]?.workspaceId ?? 'main';
  };

  it('switches the chat and the folder with the picked workspace, and back to Main', async () => {
    // Arrange
    const { fire } = await render();

    // Act
    fire('acp-workspace-select', { id: 'w1' });
    const inWorkspace = [$activeSessionId.get(), $activeRoot.get().path];
    fire('acp-workspace-select', { id: 'main' });

    // Assert
    expect(inWorkspace, "the workspace's chat and folder").to.deep.equal(['c', '/wt/one']);
    expect([$activeSessionId.get(), $activeRoot.get().path], "Main's").to.deep.equal(['m', '/p']);
  });

  it('opens a new chat of the shown workspace set to New worktree from New workspace, and creates nothing before its first message', async () => {
    // Arrange
    const { fire } = await render();
    fire('acp-workspace-select', { id: 'w1' });

    // Act
    fire('acp-workspace-new');

    // Assert
    const id = /** @type {string} */ ($activeSessionId.get());
    expect([shownChatWorkspace(), id in $draftSessions.get(), composerOf(id).runTarget]).to.deep.equal(['w1', true, { kind: 'worktree', base: null }]);
    expect(calls.filter((c) => c.cmd === 'workspace_create'), 'nothing created').to.deep.equal([]);
  });

  it("asks in the window's one dialog when the session column's header requests a delete", async () => {
    // Arrange
    const { app, fire } = await render();
    fire('acp-workspace-select', { id: 'w1' });
    const dialogs = app.querySelectorAll('acp-workspace-delete-dialog');

    // Act
    app.querySelector('acp-workspace-header')?.dispatchEvent(new CustomEvent('acp-workspace-delete-request', { detail: { id: 'w1' }, bubbles: true, composed: true }));
    await until(() => dialogs[0].workspace !== null);

    // Assert
    expect(dialogs.length).to.equal(1);
    expect(dialogs[0].workspace?.id).to.equal('w1');
  });

  it('deletes the shown workspace after asking, and shows Main', async () => {
    // Arrange
    const { app, fire } = await render();
    fire('acp-workspace-select', { id: 'w1' });
    const dialog = /** @type {HTMLElementTagNameMap['acp-workspace-delete-dialog']} */ (app.querySelector('acp-workspace-delete-dialog'));

    // Act
    fire('acp-workspace-delete-request', { id: 'w1' });
    await until(() => dialog.workspace !== null);
    dialog.dispatchEvent(new CustomEvent('acp-workspace-delete', { detail: { id: 'w1', keepBranch: true }, bubbles: true, composed: true }));
    await until(() => calls.some((c) => c.cmd === 'workspace_delete'));

    // Assert
    expect([dialog.workspace?.id, dialog.preview]).to.deep.equal(['w1', { uncommitted: 0, commits: 1, working: [] }]);
    expect(calls.find((c) => c.cmd === 'workspace_delete')?.args).to.deep.equal({ id: 'w1', keepBranch: true });
    expect([$activeWorkspaceId.get(), $activeSessionId.get()], 'Main again').to.deep.equal(['main', 'm']);
  });
  /**
   * A workspace shortcut pressed anywhere in the window (or inside `from`).
   * @param {'openWorkspaces' | 'nextWaitingWorkspace' | 'newWorkspace' | 'newChat' | `workspace${number}`} id
   * @param {EventTarget} [from]
   */
  function press(id, from = window) {
    const mac = appHook.platform === 'mac';
    const digit = /^workspace(\d)$/.exec(id)?.[1];
    const keys = { openWorkspaces: 'O', nextWaitingWorkspace: 'J', newWorkspace: 'N', newChat: 'N' };
    const key = digit ?? keys[/** @type {keyof typeof keys} */ (id)];
    const shiftKey = digit ? !mac : id !== 'newWorkspace';
    const init = { ...modKey(key, { shiftKey, altKey: Boolean(digit) && mac }), ctrlKey: !mac, metaKey: mac };
    from.dispatchEvent(new KeyboardEvent('keydown', init));
  }

  it('switches by number (1 is Main, 2 the oldest workspace) and to the next waiting workspace’s waiting chat', async () => {
    // Arrange: a second chat of the workspace waits for an answer
    await render();
    $sessions.set([
      ...$sessions.get(),
      /** @type {import('../../../hooks/sessions/types.js').Session} */ (/** @type {unknown} */ ({ id: 'asks', projectId: '/p', workspaceId: 'w1', folder: '/wt/one', status: 'waiting', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2025-12-01T00:00:00.000Z' })),
    ]);

    // Act
    press('workspace2');
    const second = $activeWorkspaceId.get();
    press('workspace3');
    const none = $activeWorkspaceId.get();
    press('workspace1');
    const first = $activeWorkspaceId.get();
    press('nextWaitingWorkspace');

    // Assert
    expect([second, none, first], '2, 3 (none), 1').to.deep.equal(['w1', 'w1', 'main']);
    expect([$activeWorkspaceId.get(), $activeSessionId.get()], 'the waiting chat').to.deep.equal(['w1', 'asks']);
  });

  it('opens the picker, a new chat set to New worktree and a plain new chat of the shown workspace by their shortcuts, not in a dialog', async () => {
    // Arrange
    const { app, fire } = await render();
    fire('acp-workspace-select', { id: 'w1' });
    const picker = /** @type {HTMLElementTagNameMap['acp-workspace-picker']} */ (app.querySelector('acp-toolbar')?.shadowRoot?.querySelector('acp-workspace-picker'));
    await picker.updateComplete;
    const menu = /** @type {HTMLElementTagNameMap['md-menu']} */ (picker.shadowRoot?.querySelector('md-menu'));
    const inDialog = document.body.appendChild(document.createElement('dialog'));
    const drafts = () => Object.values($draftSessions.get()).filter((d) => d.workspaceId === 'w1').length;

    // Act: in a dialog first, then anywhere
    for (const id of /** @type {const} */ (['openWorkspaces', 'newWorkspace', 'newChat'])) press(id, inDialog);
    const ignored = [menu.open, drafts()];
    press('newChat');
    const plain = composerOf(/** @type {string} */ ($activeSessionId.get())).runTarget;
    press('newWorkspace');
    const worktree = composerOf(/** @type {string} */ ($activeSessionId.get())).runTarget;
    press('openWorkspaces');
    await until(() => menu.open);

    // Assert
    expect(ignored, 'nothing from a dialog').to.deep.equal([false, 0]);
    expect(drafts(), 'a new chat in the workspace').to.equal(1);
    expect([plain, worktree], 'New chat: its workspace; New workspace: New worktree').to.deep.equal([undefined, { kind: 'worktree', base: null }]);
    inDialog.remove();
  });
});

describe('acp-app: mark all as read', () => {
  /** @param {string} id @param {string} projectId @returns {import('../../../hooks/sessions/types.js').Session} */
  const session = (id, projectId) => ({
    id,
    projectId,
    title: id,
    status: 'idle',
    agentId: 'a',
    config: {},
    folder: projectId,
    branch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
  });

  beforeEach(() => {
    mockIPC((cmd, args) => startupAnswer(cmd, /** @type {Record<string, unknown>} */ (args ?? {})));
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    $sessions.set([]);
    for (const id of ['mine', 'other']) $sessionReads.setKey(id, undefined);
    $project.set(null);
    clearMocks();
  });

  /** Two unread sessions, one in the active project and one in another. */
  async function render() {
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $sessionsLoaded.get());
    $sessions.set([session('mine', '/p'), session('other', '/q')]);
    for (const id of ['mine', 'other']) $sessionReads.setKey(id, { seen: '2026-01-01T00:00:00.000Z' });
    return app;
  }

  it('marks the active project’s sessions read on Mod+Shift+R, unless a dialog or a text field has the key', async () => {
    // Arrange
    const app = await render();
    expect($unreadSessions.get(), 'both unread').to.have.members(['mine', 'other']);
    const input = document.createElement('input');
    const dialog = document.createElement('dialog');
    const inDialog = document.createElement('button');
    dialog.append(inDialog);
    app.append(input, dialog);
    /** @param {Element} from */
    const pressIn = (from) =>
      from.dispatchEvent(new KeyboardEvent('keydown', modKey('R', { shiftKey: true })));

    // Act + Assert: ignored where the key belongs to something else
    for (const [from, why] of /** @type {const} */ ([[input, 'a text field'], [inDialog, 'a dialog']])) {
      pressIn(from);
      expect($unreadSessions.get(), why).to.have.members(['mine', 'other']);
    }

    // Act
    shortcut('R', { shiftKey: true });
    // Assert
    expect($unreadSessions.get(), 'only the active project’s').to.deep.equal(['other']);
  });
});

describe('acp-app: add project shortcut', () => {
  /** @type {string[]} */
  let commands;

  beforeEach(() => {
    commands = [];
    mockIPC((cmd, args) => {
      commands.push(cmd);
      if (cmd === 'plugin:dialog|open') return null;
      return startupAnswer(cmd, /** @type {Record<string, unknown>} */ (args ?? {}));
    });
  });

  afterEach(() => clearMocks());

  it('opens the folder picker on Mod+O, unless a dialog has the key', async () => {
    // Arrange
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $sessionsLoaded.get());
    const dialog = document.createElement('dialog');
    const inDialog = document.createElement('button');
    dialog.append(inDialog);
    app.append(dialog);

    // Act + Assert: a dialog keeps the key
    inDialog.dispatchEvent(new KeyboardEvent('keydown', modKey('o')));
    await new Promise((r) => setTimeout(r, 20));
    expect(commands).to.not.include('plugin:dialog|open');

    // Act
    shortcut('o');
    // Assert
    await until(() => commands.includes('plugin:dialog|open'));
  });
});

describe('acp-app: shortcuts', () => {
  beforeEach(() => mockIPC((cmd, args) => startupAnswer(cmd, /** @type {Record<string, unknown>} */ (args ?? {}))));

  afterEach(() => {
    closeAllTabs();
    clearMocks();
  });

  it('opens Quick Open on Mod+P by position on a non-Latin layout, not on the modifier that is not Mod', async () => {
    // Arrange
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    const isOpen = () => quickOpen(app).shadowRoot?.querySelector('dialog')?.open ?? false;

    // Act + Assert: the other modifier
    shortcut('з', { code: 'KeyP', [MOD]: false, [NOT_MOD]: true });
    await app.updateComplete;
    expect(isOpen(), 'the modifier that is not Mod').to.equal(false);

    // Act
    shortcut('з', { code: 'KeyP' });
    // Assert
    await until(isOpen);
  });

  it('opens Settings on Ctrl+, on Windows and Linux; on macOS the menu’s ⌘, does', async () => {
    // Arrange
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    // Act
    shortcut(',', { metaKey: false, ctrlKey: false, [MOD]: true });
    await app.updateComplete;
    // Assert
    expect($editorTabs.get().paths.includes('view:settings')).to.equal(appHook.platform !== 'mac');
  });
});

describe('acp-app: terminal panel layout', () => {
  /** @type {HTMLStyleElement} */
  let tokens;

  before(async function () {
    // The default sizes come from the app's tokens, which the page loads and the tests do not.
    this.timeout(10000);
    tokens = document.createElement('style');
    tokens.textContent = await (await fetch('/src/styles/tokens.css')).text();
    document.head.append(tokens);
  });

  after(() => tokens.remove());

  /** @type {string[]} */
  let commands;

  beforeEach(() => {
    commands = [];
    mockIPC((cmd, args) => {
      commands.push(cmd);
      return cmd === 'terminal_open' ? { shell: 'zsh', cwd: '/p' } : startupAnswer(cmd, /** @type {Record<string, unknown>} */ (args ?? {}));
    });
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    closeAllTabs();
    for (const id of Object.keys($terminals.get())) forgetTerminal(id);
    $folderTerminalTabs.set({});
    $folderTerminalPanels.set({});
    $folderTerminalPanelHeights.setKey('/p', undefined);
    $hiddenColumns.set([]);
    $project.set(null);
    clearMocks();
  });

  /** @param {string} tag */
  const boxOf = (/** @type {AcpApp} */ app, tag) => /** @type {HTMLElement} */ (app.querySelector(tag)?.assignedSlot?.parentElement).getBoundingClientRect();
  const panelBox = (/** @type {AcpApp} */ app) => boxOf(app, 'acp-terminals-view');

  /** Waits for the panes to finish sliding in, as they do when they first show. */
  async function slidIn(/** @type {AcpApp} */ app) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const panes = [...app.querySelectorAll('acp-column-split')].flatMap((split) => [...(split.shadowRoot?.querySelectorAll('acp-pane') ?? [])]);
    await Promise.all(panes.flatMap((pane) => pane.getAnimations().map((animation) => animation.finished)));
  }

  /** @param {{ file: boolean, panel: boolean }} shown */
  async function render({ file, panel }) {
    if (file) openTab('view:settings');
    if (panel) openTerminal('/p', '/p', 'p');
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $sessionsLoaded.get());
    await slidIn(app);
    return app;
  }

  it('is as tall as its project’s stored height; its handle changes that height and the agent column’s only the column widths', async () => {
    // Arrange
    setTerminalPanelHeight(300);
    const app = await render({ file: true, panel: true });
    const heightBefore = panelBox(app).height;
    const splits = [...app.querySelectorAll('acp-column-split')];
    const handleOf = (/** @type {string} */ name) =>
      /** @type {HTMLElement} */ (splits.map((split) => split.shadowRoot?.querySelector(`acp-resize-handle[name="${name}"]`)).find(Boolean));
    const press = (/** @type {HTMLElement} */ handle, /** @type {string} */ key) => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    $columnWidths.set({});

    // Act: the panel is the row below its handle, so up makes it taller
    press(handleOf('terminals'), 'ArrowUp');
    await until(() => $terminalPanelHeight.get() === 310);
    const afterPanel = [panelBox(app).height, { ...$columnWidths.get() }];
    press(handleOf('agent'), 'ArrowRight');
    await until(() => $columnWidths.get().agent !== undefined);

    // Assert
    expect(heightBefore).to.equal(300);
    expect(afterPanel, 'the panel’s own height, no column width').to.deep.equal([310, {}]);
    expect($terminalPanelHeight.get(), 'the agent column’s handle leaves it').to.equal(310);
    expect(Object.keys($columnWidths.get())).to.deep.equal(['agent']);
  });

  it('moves a terminal tab dragged from the panel onto the editor’s tabs, its shell kept and the empty panel hidden', async () => {
    // Arrange: the editor has no minimum width, so it needs the side columns' room in the test's window
    $hiddenColumns.set(['session', 'side']);
    const app = await render({ file: true, panel: true });
    const [terminalTab] = $terminalTabs.get().paths;
    const terminalId = tabs.terminalOf(terminalTab) ?? '';
    /** The md-tab of `id` in the strip inside `host`'s tab view. */
    const tabIn = (/** @type {string} */ host, /** @type {string} */ id) => {
      const strip = app.querySelector(host)?.querySelector('acp-tab-view')?.shadowRoot?.querySelector('acp-tab-strip');
      return /** @type {HTMLElement} */ (strip?.shadowRoot?.querySelector(`.acp-tab-strip__tab[value="${CSS.escape(id)}"]`));
    };
    const pressed = /** @type {HTMLElement} */ (tabIn('acp-terminals-view', terminalTab).querySelector('.acp-tab-strip__label'));
    const rect = tabIn('acp-terminals-view', terminalTab).getBoundingClientRect();
    const target = tabIn('acp-main-column', 'view:settings').getBoundingClientRect();
    const send = (/** @type {string} */ type, /** @type {number} */ x, /** @type {number} */ y) =>
      pressed.dispatchEvent(
        new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }),
      );
    const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const drop = { x: target.right + 4, y: target.top + target.height / 2 };

    // Act
    send('pointerdown', start.x, start.y);
    send('pointermove', start.x + 10, start.y);
    send('pointermove', drop.x, drop.y);
    send('pointerup', drop.x, drop.y);
    await until(() => !$terminalPanel.get().open);

    // Assert
    expect($editorTabs.get().paths).to.deep.equal(['view:settings', terminalTab]);
    expect($editorTabs.get().active).to.equal(terminalTab);
    expect($terminalTabs.get().paths).to.deep.equal([]);
    expect(commands, 'the shell lives on').to.not.include('terminal_close');
    expect($terminals.get()[terminalId], 'its terminal is still known').to.not.equal(undefined);
  });
});
