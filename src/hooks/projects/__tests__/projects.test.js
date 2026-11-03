import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect } from '@esm-bundle/chai';
import { $projects } from '../../../stores/projects/projects.js';
import {
  $projectTerminalPanelHeights,
  $projectTerminalPanels,
  $projectTerminalTabs,
  setTerminalPanelHeight,
  setTerminalPanelOpen,
} from '../../../stores/terminals/terminals.js';
import { $openingPath, $workspace } from '../../../stores/workspace/workspace.js';

/** @typedef {import('../../git/types.js').WorkspaceChanges} WorkspaceChanges */

/** @type {{ cmd: string, args: Record<string, unknown> }[]} */
let calls;
/** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} Scans held back, by path. */
let held;
/** @type {Set<string>} Paths whose scan fails. */
let failing;
let counter = 0;

/**
 * A fresh copy of the hook: its state (open roots, the latest open) is module-level.
 * @returns {Promise<typeof import('../projects.js').projects>}
 */
async function fresh() {
  return (await import(`../projects.js?fresh=${++counter}`)).projects;
}

const names = (/** @type {string} */ cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** @param {() => boolean} pred */
async function until(pred) {
  const started = Date.now();
  while (!pred()) {
    expect(Date.now() - started, 'timed out').to.be.lessThan(2000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('projects', () => {
  beforeEach(() => {
    calls = [];
    held = new Map();
    failing = new Set();
    $projects.set([]);
    $workspace.set(null);
    $openingPath.set(null);
    mockIPC(
      (cmd, args) => {
        const a = /** @type {Record<string, unknown>} */ (args ?? {});
        calls.push({ cmd, args: a });
        if (cmd === 'open_workspace') {
          const path = /** @type {string} */ (a.path);
          if (failing.has(path)) throw new Error(`cannot open ${path}`);
          if (held.has(path)) return new Promise((resolve, reject) => held.set(path, { resolve, reject }));
          return { rootId: `root:${path}`, path };
        }
        return null;
      },
      { shouldMockEvents: true },
    );
  });
  afterEach(() => {
    clearMocks();
    $workspace.set(null);
    $projects.set([]);
    $openingPath.set(null);
  });

  it('runs nothing when it is loaded', async () => {
    await fresh();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).to.deep.equal([]);
  });

  describe('opening', () => {
    it('scans a folder, makes it the workspace and lists it as a project', async () => {
      const projects = await fresh();
      await projects.activate('/work/alpha');
      expect($workspace.get()).to.deep.equal({ path: '/work/alpha', name: 'alpha', rootId: 'root:/work/alpha' });
      expect($projects.get().map((p) => p.id)).to.deep.equal(['/work/alpha']);
      expect($openingPath.get()).to.equal(null);
      expect(projects.path()).to.equal('/work/alpha');
      expect(projects.rootId()).to.equal('root:/work/alpha');
      expect(names('close_window_workspaces').length, 'last page load’s roots closed first').to.equal(1);
      expect(calls.findIndex((c) => c.cmd === 'close_window_workspaces')).to.be.lessThan(calls.findIndex((c) => c.cmd === 'open_workspace'));
    });

    it('answers relative paths against the active project', async () => {
      const projects = await fresh();
      await projects.activate('/work/alpha');
      expect(projects.absPath('src/a.js')).to.equal('/work/alpha/src/a.js');
      expect(projects.relPath('/work/alpha/src/a.js')).to.equal('src/a.js');
      expect(projects.relPath('/elsewhere/a.js')).to.equal(null);
    });

    it('switches to a project whose root is still open without scanning it again', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      await projects.activate('/work/b');
      await projects.activate('/work/a');
      expect($workspace.get()?.path).to.equal('/work/a');
      expect(names('open_workspace').map((a) => a.path)).to.deep.equal(['/work/a', '/work/b']);
      expect(projects.isOpen('root:/work/b')).to.equal(true);
    });

    it('keeps the last three roots open and closes the one used longest ago', async () => {
      const projects = await fresh();
      for (const name of ['a', 'b', 'c', 'd']) await projects.activate(`/work/${name}`);
      expect(names('close_workspace')).to.deep.equal([{ rootId: 'root:/work/a' }]);
      expect(projects.isOpen('root:/work/a')).to.equal(false);
      expect(projects.isOpen('root:/work/d')).to.equal(true);
    });

    it('scans a project only once while a second click waits for the first', async () => {
      const projects = await fresh();
      held.set('/work/slow', { resolve() {}, reject() {} });
      const first = projects.activate('/work/slow');
      await until(() => names('open_workspace').length === 1);
      expect($openingPath.get()).to.equal('/work/slow');
      const second = projects.activate('/work/slow');
      held.get('/work/slow')?.resolve({ rootId: 'root:slow', path: '/work/slow' });
      await Promise.all([first, second]);
      expect(names('open_workspace').length).to.equal(1);
      expect($workspace.get()?.rootId).to.equal('root:slow');
      expect($openingPath.get()).to.equal(null);
    });

    it('lets the newest open win, keeping an older scan that lands later for switching back', async () => {
      const projects = await fresh();
      held.set('/work/slow', { resolve() {}, reject() {} });
      $projects.set([{ id: '/work/slow', name: 'slow', path: '/work/slow' }]);
      const slow = projects.activate('/work/slow');
      await until(() => names('open_workspace').length === 1);
      await projects.activate('/work/fast');
      held.get('/work/slow')?.resolve({ rootId: 'root:slow', path: '/work/slow' });
      await slow;
      expect($workspace.get()?.path, 'the newest stays shown').to.equal('/work/fast');
      expect(projects.isOpen('root:slow'), 'the older scan is kept').to.equal(true);
    });

    it('rejects when a folder cannot be opened, and stops saying it is opening', async () => {
      const projects = await fresh();
      failing.add('/work/bad');
      let error = '';
      await projects.activate('/work/bad').catch((e) => (error = e.message));
      expect(error).to.contain('cannot open /work/bad');
      expect($openingPath.get()).to.equal(null);
      expect($workspace.get()).to.equal(null);
    });

    it('does nothing when the folder picker is cancelled', async () => {
      const projects = await fresh();
      await projects.open();
      expect(names('open_workspace')).to.deep.equal([]);
    });
  });

  describe('restoring', () => {
    it('reopens the folder of the last run', async () => {
      const projects = await fresh();
      $workspace.set({ path: '/work/last', name: 'last', rootId: null });
      await projects.restore();
      expect($workspace.get()?.rootId).to.equal('root:/work/last');
    });

    it('forgets a folder that cannot be opened any more', async () => {
      const projects = await fresh();
      failing.add('/work/gone');
      $workspace.set({ path: '/work/gone', name: 'gone', rootId: null });
      let failed = false;
      await projects.restore().catch(() => (failed = true));
      expect(failed).to.equal(true);
      expect($workspace.get()).to.equal(null);
    });

    it('closes the roots the last page load left open, with no folder to reopen too', async () => {
      const projects = await fresh();
      await projects.restore();
      expect(names('close_window_workspaces').length).to.equal(1);
    });

    it('leaves a folder that is open already alone', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      await projects.restore();
      expect(names('open_workspace').length).to.equal(1);
    });
  });

  describe('removing', () => {
    it('closes the root of a project that is not shown, keeping the one that is', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      await projects.activate('/work/b');
      projects.remove('/work/a');
      expect($projects.get().map((p) => p.id)).to.deep.equal(['/work/b']);
      expect(names('close_workspace')).to.deep.equal([{ rootId: 'root:/work/a' }]);
      expect($workspace.get()?.path).to.equal('/work/b');
    });

    it('forgets the terminal panel of a project, shown or not', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      await projects.activate('/work/b');
      for (const root of ['/work/a', '/work/b']) {
        $projectTerminalTabs.setKey(root, { paths: ['view:terminal:t'], active: 'view:terminal:t', pinned: [] });
        setTerminalPanelOpen(root, true);
      }
      setTerminalPanelHeight(300);

      projects.remove('/work/a');
      projects.remove('/work/b');

      expect($projectTerminalTabs.get()).to.deep.equal({});
      expect($projectTerminalPanels.get()).to.deep.equal({});
      expect($projectTerminalPanelHeights.get()).to.deep.equal({});
    });

    it('asks before removing a project, and removes it only when confirmed', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      await projects.activate('/work/b');
      /** @type {import('../../app/types.js').ConfirmOptions[]} */
      const asked = [];
      const dialog = (/** @type {boolean} */ answer) => ({
        confirm: async (/** @type {import('../../app/types.js').ConfirmOptions} */ o) => {
          asked.push(o);
          return answer;
        },
      });

      const declined = await projects.confirmRemove('/work/a', dialog(false));
      expect(declined).to.equal(false);
      expect($projects.get().map((p) => p.id)).to.deep.equal(['/work/a', '/work/b']);

      const confirmed = await projects.confirmRemove('/work/a', dialog(true));
      expect(confirmed).to.equal(true);
      expect($projects.get().map((p) => p.id)).to.deep.equal(['/work/b']);
      expect(asked[0]).to.include({ headline: 'Remove project?', destructive: true });
      expect(asked[0].message).to.contain('a');
    });

    it('moves on to the next project when the shown one goes, or closes the workspace with none left', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      await projects.activate('/work/b');
      projects.remove('/work/b');
      await until(() => $workspace.get()?.path === '/work/a');
      projects.remove('/work/a');
      expect($workspace.get()).to.equal(null);
      expect($projects.get()).to.deep.equal([]);
    });
  });

  describe('files changing on disk', () => {
    /** @param {string} rootId @returns {WorkspaceChanges} */
    const changes = (rootId) => ({ rootId, dirs: [''], added: ['a.js'], removed: [], modified: [], git: false });

    it('hands the active root’s changes to whoever listens, until they stop', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      /** @type {WorkspaceChanges[]} */
      const heard = [];
      const stop = projects.onFsChange((c) => heard.push(c));
      await new Promise((r) => setTimeout(r, 30));
      await emit('workspace://changed', changes('root:/work/a'));
      await until(() => heard.length === 1);
      stop();
      await new Promise((r) => setTimeout(r, 30));
      await emit('workspace://changed', changes('root:/work/a'));
      await new Promise((r) => setTimeout(r, 30));
      expect(heard.length).to.equal(1);
    });

    it('stops quietly when the backend has dropped its listener already', async () => {
      mockIPC((cmd) => {
        if (cmd === 'plugin:event|unlisten') throw new Error('no such listener');
        return 1;
      });
      const projects = await fresh();
      /** @type {unknown[]} */
      const unhandled = [];
      const note = (/** @type {PromiseRejectionEvent} */ e) => {
        unhandled.push(e.reason);
        e.preventDefault();
      };
      window.addEventListener('unhandledrejection', note);
      try {
        projects.onFsChange(() => {})();
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        window.removeEventListener('unhandledrejection', note);
      }
      expect(unhandled).to.deep.equal([]);
    });

    it('leaves the changes of the other open roots to their snapshots', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      /** @type {WorkspaceChanges[]} */
      const heard = [];
      projects.onFsChange((c) => heard.push(c));
      await new Promise((r) => setTimeout(r, 30));
      await emit('workspace://changed', changes('root:/work/other'));
      await new Promise((r) => setTimeout(r, 30));
      expect(heard).to.deep.equal([]);
    });
  });

  describe('files', () => {
    it('shows a folder in the OS file manager', async () => {
      const projects = await fresh();
      await projects.reveal('/work/a');
      expect(names('reveal_path')).to.deep.equal([{ path: '/work/a' }]);
    });

    it('notes a file as recently opened by its place in the active project', async () => {
      const projects = await fresh();
      await projects.activate('/work/a');
      projects.noteOpened('/work/a/src/a.js');
      projects.noteOpened('/elsewhere/b.js');
      expect(names('note_file_opened')).to.deep.equal([{ rootId: 'root:/work/a', path: 'src/a.js' }]);
    });
  });
});
