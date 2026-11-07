import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { expect, fixture, html } from '../../../../test/fixture.js';
import { appUpdate } from '../../../hooks/app-update/app-update.js';
import { $appUpdate } from '../../../stores/app-update/app-update.js';
import { $gitCompare, $gitRepo, NO_COMPARE, NO_REPO } from '../../../stores/git/git.js';
import { $hiddenColumns } from '../../../stores/layout/layout.js';
import { $projects } from '../../../stores/projects/projects.js';
import { $project } from '../../../stores/project/project.js';
import '../toolbar-view.js';

/** @typedef {import('../toolbar-view.js').AcpToolbarView} AcpToolbarView */

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

const settled = () => new Promise((r) => setTimeout(r, 30));

const REMOVE = 'Remove project?';
const RESTART = 'Restart Batrak?';

/**
 * The dialog showing this question.
 * @param {HTMLElement} view
 * @param {string} headline
 */
function question(view, headline) {
  const dialogs = [...view.querySelectorAll('acp-confirm-dialog')];
  return (
    dialogs.find((d) => {
      const root = /** @type {ShadowRoot} */ (d.shadowRoot);
      return root.querySelector('md-dialog[open]') !== null && root.querySelector('.acp-confirm-dialog__headline')?.textContent === headline;
    }) ?? null
  );
}

/**
 * Clicks a button of the question showing.
 * @param {HTMLElement} view
 * @param {string} headline
 * @param {string} button
 */
function answer(view, headline, button) {
  const root = /** @type {ShadowRoot} */ (question(view, headline)?.shadowRoot);
  /** @type {HTMLElement | undefined} */ ([...root.querySelectorAll('md-button')].find((b) => b.textContent?.trim() === button))?.click();
}

describe('acp-toolbar-view', () => {
  /** @type {{ cmd: string, args: Record<string, unknown> }[]} */
  let calls;
  /** @type {{ agents: number, terminals: number } | Promise<{ agents: number, terminals: number }>} */
  let blockers;

  beforeEach(() => {
    calls = [];
    blockers = { agents: 2, terminals: 1 };
    mockIPC(
      (cmd, args) => {
        const a = /** @type {Record<string, unknown>} */ (args ?? {});
        calls.push({ cmd, args: a });
        if (cmd === 'open_root') return { rootId: `root:${a.path}`, path: a.path };
        if (cmd === 'app_update_blockers') return blockers;
        if (cmd === 'app_update_state') return $appUpdate.get();
        if (cmd === 'git_branches') return { local: ['main', 'dev'], remotes: [], default: null };
        return cmd.startsWith('list_') ? [] : null;
      },
      { shouldMockEvents: true },
    );
    $projects.set([
      { id: '/p', name: 'p', path: '/p' },
      { id: '/q', name: 'q', path: '/q' },
    ]);
    $project.set({ path: '/p', name: 'p', rootId: 'r' });
  });

  afterEach(() => {
    $gitCompare.set(NO_COMPARE);
    $gitRepo.set(NO_REPO);
    $projects.set([]);
    $project.set(null);
    $hiddenColumns.set([]);
    $appUpdate.set({ state: 'none' });
    clearMocks();
  });

  /** The view, and a way to fire the toolbar's events. */
  async function render() {
    const view = /** @type {AcpToolbarView} */ (await fixture(html`<acp-toolbar-view></acp-toolbar-view>`));
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (view.querySelector('acp-toolbar'));
    /** @param {string} type @param {unknown} [detail] */
    const fire = (type, detail = null) => toolbar.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    return { view, toolbar, fire };
  }

  it('hands the projects to the toolbar, and switches and removes as the menu asks', async () => {
    // Arrange
    const { view, toolbar, fire } = await render();
    expect(toolbar.projects.map((p) => p.id), 'the listed projects').to.deep.equal(['/p', '/q']);

    // Act: switch
    fire('acp-project-select', { projectId: '/q' });
    await until(() => calls.some((c) => c.cmd === 'open_root' && c.args.path === '/q'));
    // Act: remove asks first
    const dialog = /** @type {HTMLElementTagNameMap['acp-confirm-dialog']} */ (view.querySelector('acp-confirm-dialog'));
    /** @type {string[]} */
    const asked = [];
    dialog.confirm = async (options) => {
      asked.push(options.headline);
      return true;
    };
    fire('acp-project-remove', { projectId: '/q' });
    await until(() => $projects.get().length === 1);

    // Assert
    expect(asked).to.deep.equal(['Remove project?']);
    expect($projects.get().map((p) => p.id)).to.deep.equal(['/p']);
  });

  it('hides a column and opens a page as the toolbar asks', async () => {
    // Arrange
    const { toolbar, fire } = await render();

    // Act
    fire('acp-column-toggle', { column: 'side' });
    await toolbar.updateComplete;
    fire('acp-github-open', { url: 'https://example.test/pr/1' });
    await until(() => calls.some((c) => c.cmd === 'open_url'));

    // Assert
    expect(toolbar.hiddenColumns, 'the toolbar sees it hidden').to.deep.equal(['side']);
    expect(calls.find((c) => c.cmd === 'open_url')?.args).to.deep.equal({ url: 'https://example.test/pr/1' });
  });

  it('gives the card the comparison, and loads the branches without the current one when its menu opens; no fetch', async () => {
    // Arrange
    $gitRepo.set({ repo: /** @type {import('../../../hooks/git/types.js').GitRepoState} */ ({ branch: 'main', sha: 'a1', detached: false, upstream: null, ahead: 0, behind: 0 }), error: null });
    $gitCompare.set({ ...NO_COMPARE, target: 'dev' });
    const view = /** @type {AcpToolbarView} */ (await fixture(html`<acp-toolbar-view></acp-toolbar-view>`));
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (view.querySelector('acp-toolbar'));
    await toolbar.updateComplete;
    const card = /** @type {HTMLElementTagNameMap['acp-branch-popover']} */ (/** @type {ShadowRoot} */ (toolbar.shadowRoot).querySelector('acp-branch-popover'));
    // Act
    await card.loadBranches?.();
    await view.updateComplete;
    await toolbar.updateComplete;
    // Assert
    expect(card.compareTo).to.equal('dev');
    expect(card.branches.local).to.deep.equal(['dev']);
    expect(calls.find((c) => c.cmd === 'git_branches')?.args).to.deep.equal({ rootId: 'r' });
    expect(calls.some((c) => c.cmd === 'git_fetch')).to.equal(false);
  });

  it('never shows another project’s branches: a switch clears them, a late answer is dropped, and a failed load shows none', async () => {
    // Arrange
    /** @type {{ resolve: (list: unknown) => void, reject: (err: unknown) => void }[]} */
    const asked = [];
    mockIPC((cmd) => {
      if (cmd === 'app_update_blockers') return { agents: 2, terminals: 1 };
      if (cmd === 'git_branches') return new Promise((resolve, reject) => asked.push({ resolve, reject }));
      return cmd.startsWith('list_') ? [] : null;
    });
    const view = /** @type {AcpToolbarView} */ (await fixture(html`<acp-toolbar-view></acp-toolbar-view>`));
    const toolbar = /** @type {HTMLElementTagNameMap['acp-toolbar']} */ (view.querySelector('acp-toolbar'));
    const loadBranches = /** @type {() => Promise<void>} */ (toolbar.loadBranches);
    const list = (/** @type {string} */ name) => ({ local: [name], remotes: [], default: null });
    const first = loadBranches();
    asked[0].resolve(list('of-p'));
    await first;
    const loaded = view.branches.local;
    // Act: another project is shown, and a late answer for this one comes after
    const late = loadBranches();
    $project.set({ path: '/q', name: 'q', rootId: 'r2' });
    const afterSwitch = view.branches.local;
    asked[1].resolve(list('late-of-p'));
    await late;
    const afterLate = view.branches.local;
    const failed = loadBranches();
    asked[2].reject(new Error('git failed'));
    await failed;
    // Assert
    expect(loaded).to.deep.equal(['of-p']);
    expect(afterSwitch).to.deep.equal([]);
    expect(afterLate).to.deep.equal([]);
    expect(view.branches.local).to.deep.equal([]);
  });

  describe('the update button', () => {
    const READY = /** @type {const} */ ({ state: 'ready', version: '0.9.3', onNextLaunch: false });

    it('shows the store, and does what its menu asks', async () => {
      // Arrange
      $appUpdate.set(READY);
      const { toolbar, fire } = await render();
      expect(toolbar.appUpdate, 'from the store').to.deep.equal(READY);

      /** @type {[string, unknown, string, unknown][]} */
      const cases = [
        ['acp-update-download', null, 'app_update_download', {}],
        ['acp-update-cancel', null, 'app_update_cancel', {}],
        ['acp-update-on-next-launch', { on: true }, 'app_update_on_next_launch', { on: true }],
        ['acp-update-manual', null, 'app_update_open_release', {}],
      ];
      for (const [type, detail, cmd, args] of cases) {
        // Act
        fire(type, detail);
        await until(() => calls.some((c) => c.cmd === cmd));

        // Assert
        expect(calls.find((c) => c.cmd === cmd)?.args, type).to.deep.equal(args);
      }
    });

    it('asks in its dialog before a restart that stops something', async () => {
      for (const [button, restarts] of /** @type {const} */ ([['Postpone', false], ['Restart', true]])) {
        // Arrange
        calls = [];
        $appUpdate.set(READY);
        const { view, fire } = await render();

        // Act
        fire('acp-update-restart');
        await until(() => question(view, RESTART) !== null);
        const shadow = /** @type {ShadowRoot} */ (question(view, RESTART)?.shadowRoot);
        const message = shadow.querySelector('.acp-confirm-dialog__message')?.textContent;
        answer(view, RESTART, button);
        await settled();

        // Assert
        expect(message).to.equal('2 agents are working, 1 terminal is running a program. Restarting stops them. You can continue each session after the update.');
        expect(calls.some((c) => c.cmd === 'app_update_restart'), button).to.equal(restarts);
      }
    });

    /** Update and Restart on its way, as of a clean start. */
    async function downloading() {
      calls = [];
      $projects.set([
        { id: '/p', name: 'p', path: '/p' },
        { id: '/q', name: 'q', path: '/q' },
      ]);
      $appUpdate.set({ state: 'available', version: '0.9.3', current: '0.9.2', manual: false });
      const stop = appUpdate.start();
      const { view, fire } = await render();
      fire('acp-update-download');
      await until(() => calls.some((c) => c.cmd === 'app_update_download'));
      await emit('app-update://changed', { state: 'downloading', version: '0.9.3', received: 1, total: 2 });
      return { view, fire, stop };
    }

    it('lets a question opened while it reads what is busy go first', async () => {
      // Arrange
      /** @type {(value: { agents: number, terminals: number }) => void} */
      let reply = () => {};
      blockers = new Promise((resolve) => (reply = resolve));
      const { view, fire, stop } = await downloading();
      await emit('app-update://changed', READY);
      await until(() => calls.some((c) => c.cmd === 'app_update_blockers'));
      fire('acp-project-remove', { projectId: '/q' });
      await until(() => question(view, REMOVE) !== null);

      // Act
      reply({ agents: 1, terminals: 0 });
      await settled();

      // Assert
      expect(question(view, RESTART) !== null, 'waits').to.equal(false);
      answer(view, REMOVE, 'Cancel');
      await until(() => question(view, RESTART) !== null);
      answer(view, RESTART, 'Postpone');
      stop();
    });

    it('asks by itself only with no other question open, so a click reaches what it was meant for', async () => {
      /** @type {{ why: string, order: 'remove first' | 'restart first', remove: string, removed: boolean, gone?: boolean, idle?: boolean }[]} */
      const orders = [
        { why: 'Remove open as the download ends, then chosen', order: 'remove first', remove: 'Remove', removed: true },
        { why: 'Remove open as the download ends, then cancelled', order: 'remove first', remove: 'Cancel', removed: false },
        { why: 'nothing busy still waits for the open question', order: 'remove first', remove: 'Remove', removed: true, idle: true },
        { why: 'Ready gone by the time Remove is answered', order: 'remove first', remove: 'Cancel', removed: false, gone: true },
        { why: 'Remove asked over the restart question', order: 'restart first', remove: 'Remove', removed: true },
      ];
      for (const { why, order, remove, removed, gone, idle } of orders) {
        // Arrange: Update and Restart is on its way
        blockers = idle ? { agents: 0, terminals: 0 } : { agents: 2, terminals: 1 };
        const { view, fire, stop } = await downloading();
        const restarted = () => calls.some((c) => c.cmd === 'app_update_restart');

        if (order === 'remove first') {
          // Act: the download ends behind an open question
          fire('acp-project-remove', { projectId: '/q' });
          await until(() => question(view, REMOVE) !== null);
          await emit('app-update://changed', READY);
          await settled();

          // Assert: that question stays, and nothing else came
          expect(question(view, REMOVE) !== null, `${why}: still asking`).to.equal(true);
          expect(question(view, RESTART) !== null, `${why}: not asked yet`).to.equal(false);
          expect(restarted(), `${why}: not restarted yet`).to.equal(false);

          // Act: the click lands on what it was meant for
          if (gone) await emit('app-update://changed', { state: 'installing', version: '0.9.3' });
          answer(view, REMOVE, remove);
          await settled();
          expect($projects.get().length === 1, `${why}: removed`).to.equal(removed);
          expect(restarted(), `${why}: no restart from that click`).to.equal(!!idle);
          expect(question(view, RESTART) !== null, `${why}: asked after`).to.equal(!gone && !idle);
          if (!gone && !idle) {
            answer(view, RESTART, 'Restart');
            await until(restarted);
          }
        } else {
          // Act: the question is up, and another is asked over it
          await emit('app-update://changed', READY);
          await until(() => question(view, RESTART) !== null);
          fire('acp-project-remove', { projectId: '/q' });
          await until(() => question(view, REMOVE) !== null);
          answer(view, REMOVE, remove);
          await settled();

          // Assert: each question keeps its own answer
          expect($projects.get().length === 1, `${why}: removed`).to.equal(removed);
          expect(question(view, RESTART) !== null, `${why}: still asking`).to.equal(true);
          expect(restarted(), `${why}: no restart from that click`).to.equal(false);
          answer(view, RESTART, 'Postpone');
          await settled();
          expect(restarted(), `${why}: postponed`).to.equal(false);
        }
        stop();
      }
    });
  });
});
