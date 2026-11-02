import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { $projectSearch } from '../../../stores/search/search.js';
import { $columnWidths, $hiddenColumns } from '../../../stores/layout/layout.js';
import { $projects } from '../../../stores/projects/projects.js';
import { $workspace } from '../../../stores/workspace/workspace.js';
import { tabs } from '../../../hooks/tabs/tabs.js';
import { $sessionReads, $unreadSessions } from '../../../stores/session-read/session-read.js';
import { $sessions, $sessionsLoaded } from '../../../stores/sessions/sessions.js';
import { $editorTabs, closeAllTabs, openTab } from '../../../stores/editor/editor.js';
import {
  $projectTerminalPanelHeights,
  $projectTerminalPanels,
  $projectTerminalTabs,
  $terminalPanel,
  $terminalPanelHeight,
  $terminalTabs,
  $terminals,
  forgetTerminal,
  openTerminal,
  setTerminalPanelHeight,
  setTerminalPanelOpen,
} from '../../../stores/terminals/terminals.js';
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

/**
 * A shortcut pressed anywhere in the window.
 * @param {string} key
 * @param {KeyboardEventInit} [init]
 */
function shortcut(key, init = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...init }));
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
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
    $projectSearch.setKey('/p', { ...STATE, recent: ['older'] });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    for (const el of document.querySelectorAll('acp-app')) searchDialog(/** @type {AcpApp} */ (el))?.close();
    $projectSearch.setKey('/p', undefined);
    $workspace.set(null);
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

describe('acp-app: mark all as read', () => {
  /** @param {string} id @param {string} projectId @returns {import('../../../hooks/sessions/types.js').Session} */
  const session = (id, projectId) => ({
    id,
    projectId,
    title: id,
    status: 'idle',
    agentId: 'a',
    config: {},
    mode: 'local',
    folder: projectId,
    worktreePath: null,
    branch: null,
    baseCommit: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
  });

  beforeEach(() => {
    mockIPC((cmd, args) => startupAnswer(cmd, /** @type {Record<string, unknown>} */ (args ?? {})));
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    $sessions.set([]);
    for (const id of ['mine', 'other']) $sessionReads.setKey(id, undefined);
    $workspace.set(null);
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
      from.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', metaKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true }));

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

describe('acp-app: branch popover', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {(cmd: string) => unknown} */
  let answer;

  /** @param {import('../../../hooks/sessions/types.js').SessionStatus} status @param {string} folder @returns {import('../../../hooks/sessions/types.js').Session} */
  const session = (status, folder) => ({
    id: 's',
    projectId: folder,
    title: 'Fix it',
    status,
    agentId: 'a',
    config: {},
    mode: 'local',
    folder,
    worktreePath: null,
    branch: null,
    baseCommit: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    titleSource: 'prompt',
    agentTitle: null,
  });

  beforeEach(() => {
    calls = [];
    answer = () => undefined;
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      return answer(cmd) ?? startupAnswer(cmd, a);
    });
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $sessions.set([]);
    $workspace.set(null);
    clearMocks();
  });

  /** The app, and its toolbar with the answers to the switch recorded. */
  async function render() {
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $sessionsLoaded.get());
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (app.querySelector('acp-toolbar'));
    /** @type {(string | null)[]} */
    const finished = [];
    toolbar.switchFinished = (error) => void finished.push(error);
    /** @param {string} type @param {unknown} [detail] */
    const fire = (type, detail = null) => toolbar.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    return { toolbar, finished, fire };
  }

  const switches = () => calls.filter((c) => c.cmd === 'git_switch').map((c) => c.args);

  it('reads the project’s branches when the popover opens and hands them to the toolbar', async () => {
    // Arrange
    const list = { local: [{ name: 'main', current: true, ahead: 0, behind: 0, committedAt: 1 }], remote: [] };
    answer = (cmd) => (cmd === 'git_branches_detail' ? list : undefined);
    const { toolbar, fire } = await render();
    // Act
    fire('acp-git-branches-query');
    await until(() => toolbar.branches !== null);
    // Assert
    expect(toolbar.branches).to.deep.equal(list);
    expect(calls.find((c) => c.cmd === 'git_branches_detail')?.args).to.deep.equal({ rootId: 'r' });
  });

  it('switches the branch and tells the popover, whether git did it, refused, or an agent is working in the folder', async () => {
    // Arrange
    const { finished, fire } = await render();
    // Act: it works
    fire('acp-git-switch', { branch: 'dev', create: false });
    await until(() => finished.length === 1);
    // Assert
    expect(switches()).to.deep.equal([{ rootId: 'r', branch: 'dev', create: false }]);
    expect(finished).to.deep.equal([null]);

    // Act: git refuses
    answer = (cmd) => {
      if (cmd === 'git_switch') throw new Error('would be overwritten');
      return undefined;
    };
    fire('acp-git-switch', { branch: 'x', create: true });
    await until(() => finished.length === 2);
    // Assert
    expect(finished[1]).to.contain('would be overwritten');

    // Act: an agent works in this folder (one in another folder doesn't count)
    answer = () => undefined;
    $sessions.set([session('working', '/q'), session('working', '/p')]);
    fire('acp-git-switch', { branch: 'dev', create: false });
    await until(() => finished.length === 3);
    // Assert
    expect(finished[2]).to.contain('“Fix it” is working in this folder');
    expect(switches(), 'git is not asked').to.have.length(2);
  });
});

describe('acp-app: project menu', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      calls.push({ cmd, args: a });
      if (cmd === 'open_workspace') return { rootId: `root:${a.path}`, path: a.path };
      return startupAnswer(cmd, a);
    });
    $projects.set([
      { id: '/p', name: 'p', path: '/p' },
      { id: '/q', name: 'q', path: '/q' },
    ]);
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $projects.set([]);
    $workspace.set(null);
    clearMocks();
  });

  /** The app, and a way to fire the project menu's events from the toolbar. */
  async function render() {
    const app = /** @type {AcpApp} */ (await fixture(html`<acp-app></acp-app>`));
    await until(() => $sessionsLoaded.get());
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (app.querySelector('acp-toolbar'));
    /** @param {string} type @param {unknown} [detail] */
    const fire = (type, detail = null) => toolbar.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    return { app, toolbar, fire };
  }

  it('hands the projects to the toolbar, and switches, reveals and removes as the menu asks', async () => {
    // Arrange
    const { app, toolbar, fire } = await render();
    expect(toolbar.projects.map((p) => p.id), 'the listed projects').to.deep.equal(['/p', '/q']);

    // Act: switch
    fire('acp-project-select', { projectId: '/q' });
    await until(() => calls.some((c) => c.cmd === 'open_workspace' && c.args.path === '/q'));
    // Act: reveal the shown project
    fire('acp-project-reveal', { projectId: '/p' });
    await until(() => calls.some((c) => c.cmd === 'reveal_path'));
    // Act: remove asks first
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (app.querySelector('.acp-app__confirm'));
    /** @type {string[]} */
    const asked = [];
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return true;
    };
    fire('acp-project-remove', { projectId: '/q' });
    await until(() => $projects.get().length === 1);

    // Assert
    expect(calls.find((c) => c.cmd === 'reveal_path')?.args).to.deep.equal({ path: '/p' });
    expect(asked).to.deep.equal(['Remove project?']);
    expect($projects.get().map((p) => p.id)).to.deep.equal(['/p']);
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
    $workspace.set({ path: '/p', name: 'p', rootId: 'r' });
    $hiddenColumns.set([]);
  });

  afterEach(() => {
    closeAllTabs();
    for (const id of Object.keys($terminals.get())) forgetTerminal(id);
    $projectTerminalTabs.set({});
    $projectTerminalPanels.set({});
    $projectTerminalPanelHeights.setKey('/p', undefined);
    $hiddenColumns.set([]);
    $workspace.set(null);
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

  /** @returns {number} The gap between columns, px. */
  function gapPx() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position: absolute; visibility: hidden; width: var(--acp-column-gap)';
    document.body.append(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    return px;
  }

  for (const [name, panel, hide] of /** @type {const} */ ([
    ['has no terminals', false, false],
    ['is hidden with its terminals', true, true],
  ])) {
    it(`leaves the columns at the full height of the window while the panel ${name}`, async () => {
      // Arrange / Act
      const app = await render({ file: true, panel });
      if (hide) {
        setTerminalPanelOpen('/p', false);
        await slidIn(app);
      }
      const [session, agent, main, side] = ['acp-session-column', 'acp-agent-column', 'acp-main-column', 'acp-file-column'].map((tag) => boxOf(app, tag));

      // Assert
      for (const box of [agent, main, side]) {
        expect([box.top, box.height], 'same row as the sessions').to.deep.equal([session.top, session.height]);
      }
      expect(agent.left, 'agent after sessions').to.be.closeTo(session.right + gapPx(), 0.5);
      expect(main.left, 'main after agent').to.be.closeTo(agent.right + gapPx(), 0.5);
      expect(panelBox(app).width, 'the panel takes no room').to.equal(0);
    });
  }

  for (const [name, hiddenColumns, file] of /** @type {const} */ ([
    ['with a file tab', [], true],
    ['without one: the agent column is the whole middle', [], false],
    ['with the sessions column hidden', ['session'], true],
    ['with the file column hidden', ['side'], true],
  ])) {
    it(`sits under the agent and editor columns, which keep the sessions and files full height, ${name}`, async () => {
      // Arrange
      $hiddenColumns.set([...hiddenColumns]);

      // Act
      const app = await render({ file, panel: true });
      const panel = panelBox(app);
      const agent = boxOf(app, 'acp-agent-column');
      const main = boxOf(app, 'acp-main-column');
      const full = /** @type {readonly string[]} */ (hiddenColumns).includes('session') ? boxOf(app, 'acp-file-column') : boxOf(app, 'acp-session-column');

      // Assert
      expect(panel.left, 'from the agent column').to.equal(agent.left);
      expect(panel.right, 'to the editor column, or the agent column alone').to.equal(file ? main.right : agent.right);
      expect(panel.top, 'below them').to.be.closeTo(agent.bottom + gapPx(), 0.5);
      expect(panel.bottom, 'to the window’s end').to.equal(full.bottom);
      expect(agent.height, 'they gave it the room').to.be.lessThan(full.height);
    });
  }

  it('gives the editor the whole middle while the agent column is hidden', async () => {
    // Arrange
    $hiddenColumns.set(['agent']);

    // Act
    const app = await render({ file: true, panel: false });
    const session = boxOf(app, 'acp-session-column');
    const main = boxOf(app, 'acp-main-column');

    // Assert
    expect(boxOf(app, 'acp-agent-column').width, 'agent hidden').to.equal(0);
    expect(main.left, 'editor right after the sessions').to.be.closeTo(session.right + gapPx(), 0.5);
  });

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
    // Arrange
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
