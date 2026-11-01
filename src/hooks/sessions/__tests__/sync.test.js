import { expect } from '@esm-bundle/chai';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { poll, sync, syncAgentOf } from '../sync.js';
import { $notices } from '../../../stores/notices/notices.js';
import { $sessionSync, endSync, syncOf } from '../../../stores/session-sync/session-sync.js';
import { $sessions } from '../../../stores/sessions/sessions.js';
import { $workspace } from '../../../stores/workspace/workspace.js';

/** @type {import('../../../models/types/types.js').SyncReport} */
const REPORT = { projectPath: '/p', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', agents: [{ agentId: 'claude', agentName: 'Claude', outcome: 'listed', count: 2, error: null }] };

let counter = 0;
/** A project id no earlier test synced: the throttles are module state. */
const fresh = () => `/p/${++counter}-${Math.random()}`;

describe('sessions sync', () => {
  /** @type {{ args: Record<string, unknown> }[]} */
  let asked;
  /** @type {Promise<unknown> | null} */
  let hold;
  /** @type {Error | null} */
  let fail;

  beforeEach(() => {
    asked = [];
    hold = null;
    fail = null;
    mockIPC((cmd, args) => {
      if (cmd !== 'sessions_sync') return null;
      asked.push({ args: /** @type {Record<string, unknown>} */ (args) });
      if (fail) throw fail;
      return hold ?? REPORT;
    });
    $notices.set([]);
  });

  afterEach(() => {
    $sessionSync.set({});
    $sessions.set([]);
    $workspace.set(null);
    $notices.set([]);
    clearMocks();
  });

  it('asks a project’s agents once for a while, again when forced or for chosen agents, and shows the answer', async () => {
    const id = fresh();
    await sync(id);
    await sync(id);
    expect(asked.map((a) => a.args), 'the second is too soon').to.deep.equal([{ projectPath: id, agentIds: null }]);
    expect(syncOf(id).report).to.deep.equal(REPORT);
    await sync(id, { force: true });
    await sync(id, { agentIds: ['claude'] });
    expect(asked.map((a) => a.args.agentIds)).to.deep.equal([null, null, ['claude']]);
  });

  it('shows a spinner for a sync, none for a quiet one, and clears it with the report', async () => {
    let release = () => {};
    hold = new Promise((resolve) => (release = () => resolve(REPORT)));
    const loud = fresh();
    const running = sync(loud);
    expect(syncOf(loud).running).to.equal(true);
    release();
    await running;
    expect(syncOf(loud).running).to.equal(false);

    hold = null;
    const quiet = fresh();
    await sync(quiet, { quiet: true });
    expect(asked.at(-1)?.args.projectPath).to.equal(quiet);
    expect(syncOf(quiet).report, 'a quiet answer still lands').to.deep.equal(REPORT);
  });

  it('reports a failed sync with a message, or only in the log when quiet', async () => {
    fail = new Error('agent crashed');
    const loud = fresh();
    await sync(loud);
    expect(syncOf(loud)).to.deep.include({ running: false, report: null });
    expect($notices.get().map((n) => n.level), 'a visible failure').to.include('error');
    $notices.set([]);
    await sync(fresh(), { quiet: true });
    expect($notices.get(), 'a failed poll stays quiet').to.deep.equal([]);
  });

  it('polls only a shown project whose last sync listed or failed, quietly, and not while one runs', async () => {
    const id = fresh();
    $workspace.set(/** @type {never} */ ({ path: id, rootId: null }));
    poll();
    expect(asked, 'never synced: nothing to repeat').to.deep.equal([]);
    endSync(id, { ...REPORT, agents: [REPORT.agents[0], { agentId: 'codex', agentName: 'Codex', outcome: 'off', count: null, error: null }, { agentId: 'gem', agentName: 'Gem', outcome: 'failed', count: null, error: 'x' }] });
    poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked.map((a) => a.args.agentIds), 'listing and failed agents only').to.deep.equal([['claude', 'gem']]);
    $sessionSync.set({ ...$sessionSync.get(), [id]: { running: true, report: REPORT } });
    poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked, 'not while a sync runs').to.have.length(1);
    $sessionSync.set({ ...$sessionSync.get(), [id]: { running: false, report: REPORT } });
    let release = () => {};
    hold = new Promise((resolve) => (release = () => resolve(REPORT)));
    const quiet = sync(id, { agentIds: ['claude'], quiet: true });
    poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked, 'not while a quiet sync of it is in flight').to.have.length(2);
    release();
    await quiet;
  });

  it('syncs a clicked session’s agent, at most every half minute per agent, and then waits for the sync running', async () => {
    const id = fresh();
    $sessions.set([/** @type {never} */ ({ id: 's1', projectId: id, agentId: 'claude' }), /** @type {never} */ ({ id: 's2', projectId: id, agentId: 'codex' })]);
    await syncAgentOf('s1');
    await syncAgentOf('s1');
    await syncAgentOf('s2');
    await syncAgentOf('gone');
    expect(asked.map((a) => a.args.agentIds), 'one per agent').to.deep.equal([['claude'], ['codex']]);

    let release = () => {};
    hold = new Promise((resolve) => (release = () => resolve(REPORT)));
    const running = sync(id, { agentIds: ['codex'] });
    let waited = false;
    const second = syncAgentOf('s1').then(() => (waited = true));
    await new Promise((r) => setTimeout(r, 20));
    expect([waited, asked.length], 'throttled: asks nothing new, but waits for the sync running').to.deep.equal([false, 3]);
    release();
    await running;
    await second;
    expect(waited).to.equal(true);
  });
});
