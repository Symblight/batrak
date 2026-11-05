import { git } from '../../hooks/git/git.js';
import { tabs } from '../../hooks/tabs/tabs.js';
import { StoreController } from '../store/StoreController.js';
import { workspaces } from '../../hooks/workspaces/workspaces.js';
import { projects } from '../../hooks/projects/projects.js';
import { $activePath } from '../../stores/editor/editor.js';
import { $sessions } from '../../stores/sessions/sessions.js';
import { $workspaces } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('../../hooks/tabs/types.js').FileDiff} FileDiff */
/** @typedef {import('../../hooks/git/types.js').GitChangesView} GitChangesView */
/**
 * What a workspace's Changes tab shows.
 * @typedef {Object} WorkspaceChangesView
 * @property {string} workspaceId
 * @property {GitChangesView} changes Paths relative to `folder`.
 * @property {ReadonlySet<string>} expanded
 * @property {ReadonlyMap<string, FileDiff>} diffs
 * @property {string} folder The workspace's folder.
 * @property {string} base Its base commit.
 * @property {string | null} branch
 */

/** @type {GitChangesView} */
const NOT_LOADED = { files: [], loaded: false, loading: true, error: null };

/** @param {string} id */
function workspaceOf(id) {
  return $workspaces.get().find((w) => w.id === id) ?? null;
}

/**
 * @param {string} id
 * @returns {Set<string>} The workspace's chats that are mid-turn.
 */
function busyChats(id) {
  return new Set(
    $sessions
      .get()
      .filter((s) => s.workspaceId === id && (s.status === 'working' || s.status === 'waiting'))
      .map((s) => s.id),
  );
}

/**
 * @typedef {Object} WorkspaceChangesConfig
 * @property {() => string | null} workspaceId The workspace whose tab the host shows.
 */

/**
 * A workspace's Changes tab while it's active: the files changed in it since its base, which of
 * them are expanded, and their diffs against its base. Listed when the tab is shown and again
 * after each turn of any of its chats (nothing watches a worktree); dropped when another tab
 * is shown. One per tab: it follows its host's workspace only.
 * @implements {ReactiveController}
 */
export class WorkspaceChangesController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {WorkspaceChangesConfig} */
  #config;
  /** @type {string | null} The workspace whose tab is active. */
  #workspaceId = null;
  /** @type {GitChangesView} */
  #changes = NOT_LOADED;
  /** @type {ReadonlySet<string>} */
  #expanded = new Set();
  /** @type {ReadonlyMap<string, FileDiff>} */
  #diffs = new Map();
  /** @type {Map<string, number>} Latest diff read per file; an older one that resolves later is dropped. */
  #loads = new Map();
  /** Sequence number handed to each diff/file read. */
  #loadCount = 0;
  /** Latest list asked for; an older one that resolves later (a slow scan) is dropped. */
  #listCount = 0;
  /** @type {ReadonlySet<string>} The shown workspace's chats mid-turn at the last statuses. */
  #busy = new Set();

  /**
   * @param {ReactiveControllerHost & HTMLElement} host
   * @param {WorkspaceChangesConfig} config
   */
  constructor(host, config) {
    this.#host = host;
    this.#config = config;
    new StoreController(host, {
      store: $activePath,
      onChange: () => this.sync(),
    });
    new StoreController(host, {
      store: $sessions,
      onChange: () => {
        if (this.#workspaceId === null) return;
        const busy = busyChats(this.#workspaceId);
        if ([...this.#busy].some((id) => !busy.has(id))) this.#list();
        this.#busy = busy;
      },
    });
    host.addController(this);
  }

  /** Shows the host's workspace if its tab is the active one, else nothing; call it when the host's workspace changes. */
  sync() {
    const active = $activePath.get();
    const id = active === null ? null : tabs.workspaceOf(active);
    this.#show(id !== null && id === this.#config.workspaceId() ? id : null);
  }

  // Shown again on connect, when the active tab is first reported.
  hostDisconnected() {
    this.#show(null);
  }

  /** @returns {WorkspaceChangesView | null} `null` unless a listed workspace's tab is active. */
  get view() {
    const workspace = this.#workspaceId === null ? null : workspaceOf(this.#workspaceId);
    if (!workspace) return null;
    return {
      workspaceId: workspace.id,
      changes: this.#changes,
      expanded: this.#expanded,
      diffs: this.#diffs,
      folder: workspace.folder,
      base: workspace.baseCommit,
      branch: workspace.branch,
    };
  }

  /** @param {string | null} workspaceId */
  #show(workspaceId) {
    if (workspaceId === this.#workspaceId) return;
    this.#workspaceId = workspaceId;
    this.#changes = NOT_LOADED;
    this.#expanded = new Set();
    this.#diffs = new Map();
    this.#loads.clear();
    this.#busy = workspaceId === null ? new Set() : busyChats(workspaceId);
    if (workspaceId !== null) this.#list();
    this.#host.requestUpdate();
  }

  /** Lists the changed files; the expanded ones still listed are read again. */
  async #list() {
    const id = this.#workspaceId;
    if (id === null) return;
    const list = ++this.#listCount;
    this.#changes = { ...this.#changes, loading: true };
    this.#host.requestUpdate();
    /** @type {GitChangesView} */
    let changes;
    try {
      changes = { files: await workspaces.listChanges(id), loaded: true, loading: false, error: null };
    } catch (err) {
      changes = { files: [], loaded: true, loading: false, error: String(err) };
    }
    if (id !== this.#workspaceId || list !== this.#listCount) return;
    this.#changes = changes;
    const listed = new Set(changes.files.map((file) => file.path));
    this.#expanded = new Set([...this.#expanded].filter((rel) => listed.has(rel)));
    for (const rel of this.#expanded) this.#loadDiff(rel);
    this.#host.requestUpdate();
  }

  /** @param {string} rel */
  expand(rel) {
    if (this.#expanded.has(rel)) return;
    this.#expanded = new Set([...this.#expanded, rel]);
    this.#host.requestUpdate();
    if (this.#changes.files.some((file) => file.path === rel)) this.#loadDiff(rel);
  }

  /** @param {string} rel */
  toggle(rel) {
    if (!this.#expanded.has(rel)) {
      this.expand(rel);
      return;
    }
    const next = new Set(this.#expanded);
    next.delete(rel);
    this.#expanded = next;
    this.#host.requestUpdate();
  }

  /** Collapses every expanded file. */
  collapseAll() {
    this.#expanded = new Set();
    this.#host.requestUpdate();
  }

  /**
   * Reads a file in the worktree and its text at the base: a deleted file is nothing against the
   * base, a new one the file against nothing.
   * @param {string} rel
   */
  async #loadDiff(rel) {
    const id = this.#workspaceId;
    const workspace = id === null ? null : workspaceOf(id);
    if (id === null || !workspace) return;
    const load = ++this.#loadCount;
    this.#loads.set(rel, load);
    if (!this.#diffs.has(rel)) this.#setDiff(rel, { content: '', baseline: '', error: '', loading: true });
    const diff = await git.readDiff(projects.readFile(`${workspace.folder}/${rel}`), workspaces.fileAtBase(id, rel));
    if (id !== this.#workspaceId || this.#loads.get(rel) !== load) return;
    this.#setDiff(rel, diff);
  }

  /**
   * @param {string} rel
   * @param {FileDiff} diff
   */
  #setDiff(rel, diff) {
    this.#diffs = new Map(this.#diffs).set(rel, diff);
    this.#host.requestUpdate();
  }
}
