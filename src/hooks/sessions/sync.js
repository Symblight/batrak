import { app } from '../app/app.js';
import { endSync, startSync, syncOf } from '../../stores/session-sync/session-sync.js';
import { $sessions } from '../../stores/sessions/sessions.js';
import { $projectPath } from '../../stores/project/project.js';
import { sessionsSync } from './commands.js';

/** A project shown again is synced with its agents when its last sync is older than this. */
const SYNC_STALE_MS = 5 * 60_000;
/** Clicking a session syncs its agent's sessions, at most this often per agent and project. */
const SELECT_SYNC_MS = 30_000;

/** @type {Map<string, number>} When each project's last sync started, ms. */
const syncedAt = new Map();
/** @type {Map<string, number>} When a click last synced an agent of a project (`project\0agent`), ms. */
const selectSyncedAt = new Map();
/** @type {Map<string, Promise<void>>} Each project's syncs running now; settles once all have. */
const syncing = new Map();

/**
 * Asks the shown project's agents that list for its sessions again, quietly (no spinner), while
 * the window is visible.
 */
function poll() {
  const path = $projectPath.get();
  if (path === null || document.visibilityState !== 'visible') return;
  const { report, running } = syncOf(path);
  if (report === null || running || syncing.has(path)) return;
  const listing = report.agents
    .filter((a) => a.outcome === 'listed' || a.outcome === 'failed')
    .map((a) => a.agentId);
  if (listing.length > 0) sync(path, { agentIds: listing, quiet: true });
}

/**
 * Asks a project's agents for its sessions; they arrive through `sessions://synced`. Skipped while
 * the last sync is younger than `SYNC_STALE_MS`, unless `force` or `agentIds` are given. A `quiet`
 * one (a poll) shows no spinner and reports no failure.
 * @param {string} projectId
 * @param {{ force?: boolean, agentIds?: string[] | null, quiet?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function sync(projectId, { force = false, agentIds = null, quiet = false } = {}) {
  const last = syncedAt.get(projectId);
  if (!force && agentIds === null && last !== undefined && Date.now() - last < SYNC_STALE_MS) return;
  if (agentIds === null) syncedAt.set(projectId, Date.now());
  if (!quiet) startSync(projectId);
  const run = sessionsSync(projectId, agentIds).then(
    (report) => endSync(projectId, report),
    (err) => {
      if (quiet) {
        app.log('warn', `polling sessions failed: ${err}`);
        return;
      }
      endSync(projectId, null);
      app.reportError('Syncing sessions failed', err);
    },
  );
  // Another sync of the project may still run (a click's during the full one): wait for both.
  const before = syncing.get(projectId);
  const all = before === undefined ? run : Promise.all([before, run]).then(() => {});
  syncing.set(projectId, all);
  all.then(() => {
    if (syncing.get(projectId) === all) syncing.delete(projectId);
  });
  await run;
}

/**
 * A click on a session syncs its agent's sessions of the project (at most every `SELECT_SYNC_MS`);
 * resolves once that sync, or the project's sync running now, answered.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function syncAgentOf(id) {
  const session = $sessions.get().find((s) => s.id === id);
  if (!session) return;
  const key = `${session.projectId}\0${session.agentId}`;
  const last = selectSyncedAt.get(key);
  if (last !== undefined && Date.now() - last < SELECT_SYNC_MS) {
    await syncing.get(session.projectId);
    return;
  }
  selectSyncedAt.set(key, Date.now());
  await sync(session.projectId, { agentIds: [session.agentId] });
}

export { poll, sync, syncAgentOf };
