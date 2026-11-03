import { isActiveElsewhere } from '../sessions/rules.js';

/** @typedef {import('./types.js').Workspace} Workspace */
/** @typedef {import('./types.js').WorkspaceStatus} WorkspaceStatus */
/** @typedef {import('../sessions/types.js').Session} Session */

/** Statuses, the strongest first: a workspace shows the strongest of its chats'. */
export const STATUS_ORDER = /** @type {const} */ (['waiting', 'error', 'working', 'unread', 'idle']);

const WORKING = new Set(['preparing', 'starting', 'working', 'queued']);

/**
 * A workspace's status (Main's for `null`): the strongest of its chats', and its own failed or
 * running checkout and missing folder.
 * @param {Workspace | null} workspace
 * @param {readonly Session[]} chats Its chats.
 * @param {{ pending: ReadonlySet<string>, unread: ReadonlySet<string>, now: number }} facts Ids of
 *   chats with a permission request waiting, of unread chats; the current time (ms).
 * @returns {WorkspaceStatus}
 */
export function statusOf(workspace, chats, { pending, unread, now }) {
  if (chats.some((c) => c.status === 'waiting' || pending.has(c.id))) return 'waiting';
  if (workspace?.missing || workspace?.error || chats.some((c) => c.status === 'error')) return 'error';
  if (workspace?.creating || chats.some((c) => WORKING.has(c.status) || isActiveElsewhere(c, now))) return 'working';
  if (chats.some((c) => unread.has(c.id))) return 'unread';
  return 'idle';
}

/**
 * The picker's Active group: by status, the strongest first, then the latest activity (its own, or
 * its chats') first. Main isn't in it: it's a group of its own, after.
 * @param {readonly Workspace[]} list
 * @param {Readonly<Record<string, WorkspaceStatus>>} statuses By workspace id.
 * @param {readonly Session[]} chats The project's chats.
 */
export function orderWorkspaces(list, statuses, chats) {
  /** @param {Workspace} w */
  const activity = (w) =>
    Math.max(
      Date.parse(w.createdAt) || 0,
      Date.parse(w.lastActiveAt ?? '') || 0,
      ...chats.filter((c) => c.workspaceId === w.id).map((c) => Date.parse(c.lastActivityAt) || 0),
    );
  /** @param {Workspace} w */
  const rank = (w) => STATUS_ORDER.indexOf(statuses[w.id] ?? 'idle');
  return [...list].sort((a, b) => rank(a) - rank(b) || activity(b) - activity(a));
}

/**
 * The branch a workspace named `name` gets (`brama/<slug>`, `-2`, `-3`… past `taken`), as the
 * backend's `env::slug` makes it.
 * @param {string} name
 * @param {readonly string[]} taken Branches the project's workspaces have.
 */
export function slugPreview(name, taken) {
  let slug = '';
  for (const c of name.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) slug += c;
    else if (slug !== '' && !slug.endsWith('-')) slug += '-';
    if (slug.length >= 32) break;
  }
  const stem = `brama/${slug.replace(/-+$/, '') || 'workspace'}`;
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  let n = 2;
  while (used.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/**
 * Where a draft of workspace `workspaceId` creates its chat: Main, a draft workspace's new one
 * (placed from its base), or the stored one.
 * @param {string} workspaceId `main`, a stored workspace's id or a draft workspace's.
 * @param {Readonly<Record<string, import('./types.js').DraftWorkspace>>} drafts Draft workspaces by id.
 * @returns {import('./types.js').WorkspaceChoice}
 */
export function choiceOf(workspaceId, drafts) {
  if (workspaceId === 'main') return { kind: 'main' };
  const draft = drafts[workspaceId];
  return draft ? { kind: 'new', baseBranch: draft.baseBranch } : { kind: 'existing', id: workspaceId };
}

/**
 * The status of each workspace of a project and of Main (`main`), from its chats (`statusOf()`).
 * @param {string} projectPath
 * @param {readonly Workspace[]} list The project's workspaces.
 * @param {readonly Session[]} sessions Every chat.
 * @param {{ pending: ReadonlySet<string>, unread: ReadonlySet<string>, now: number }} facts As `statusOf()` takes them.
 * @returns {Record<string, WorkspaceStatus>}
 */
export function statusesOf(projectPath, list, sessions, facts) {
  const chats = sessions.filter((s) => s.projectId === projectPath);
  /** @type {Record<string, WorkspaceStatus>} */
  const statuses = { main: statusOf(null, chats.filter((c) => !c.workspaceId), facts) };
  for (const w of list) statuses[w.id] = statusOf(w, chats.filter((c) => c.workspaceId === w.id), facts);
  return statuses;
}

/**
 * The workspace "next waiting" goes to: the first waiting one after the shown one in the picker's
 * order (Active, then Main), wrapping around; `null` when no other one waits.
 * @param {readonly string[]} order Workspace ids, Main's (`main`) among them.
 * @param {Readonly<Record<string, WorkspaceStatus>>} statuses By workspace id.
 * @param {string} shownId
 * @returns {string | null}
 */
export function nextWaiting(order, statuses, shownId) {
  const from = order.indexOf(shownId) + 1;
  const rotated = [...order.slice(from), ...order.slice(0, from)];
  return rotated.find((id) => id !== shownId && statuses[id] === 'waiting') ?? null;
}
