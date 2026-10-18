import { StoreController } from '../store/StoreController.js';
import { readFile, sessionChanges, sessionFileAtBase } from '../../services/ipc.js';
import { sessionOfTab } from '../../models/tab-ids.js';
import { $activePath } from '../../stores/editor.js';
import { $sessions } from '../../stores/sessions.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('../../models/types.js').FileDiff} FileDiff */
/** @typedef {import('../../models/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../models/types.js').Session} Session */

/**
 * What a worktree session's Changes tab shows.
 * @typedef {Object} SessionChangesView
 * @property {string} sessionId
 * @property {GitChangesView} changes Paths relative to `folder`.
 * @property {ReadonlySet<string>} expanded
 * @property {ReadonlyMap<string, FileDiff>} diffs
 * @property {string} folder The session's folder.
 * @property {string} base The commit it started from.
 */

/** @type {GitChangesView} */
const NOT_LOADED = { files: [], loaded: false, loading: true, error: null };

/** @param {string} id */
function sessionOf(id) {
  return $sessions.get().find((s) => s.id === id) ?? null;
}

/** @param {Session | null} session */
function isBusy(session) {
  return session?.status === 'working' || session?.status === 'waiting';
}

/**
 * A worktree session's Changes tab while it's active: the files the session changed since it
 * started, which of them are expanded, and their diffs against its base. Listed when the tab is
 * shown and again after each of the session's turns (nothing watches a worktree); dropped when
 * another tab is shown.
 * @implements {ReactiveController}
 */
export class SessionChangesController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {string | null} The session whose tab is active. */
  #sessionId = null;
  /** @type {GitChangesView} */
  #changes = NOT_LOADED;
  /** @type {ReadonlySet<string>} */
  #expanded = new Set();
  /** @type {ReadonlyMap<string, FileDiff>} */
  #diffs = new Map();
  /** @type {Map<string, number>} Latest diff read per file; an older one that resolves later is dropped. */
  #loads = new Map();
  #loadCount = 0;
  /** The shown session was mid-turn at its last status. */
  #busy = false;

  /** @param {ReactiveControllerHost & HTMLElement} host */
  constructor(host) {
    this.#host = host;
    new StoreController(host, {
      store: $activePath,
      onChange: (active) => this.#show(active === null ? null : sessionOfTab(active)),
    });
    new StoreController(host, {
      store: $sessions,
      onChange: () => {
        if (this.#sessionId === null) return;
        const busy = isBusy(sessionOf(this.#sessionId));
        if (this.#busy && !busy) this.#list();
        this.#busy = busy;
      },
    });
    host.addController(this);
  }

  // Shown again on connect, when the active tab is first reported.
  hostDisconnected() {
    this.#show(null);
  }

  /** @returns {SessionChangesView | null} `null` unless a worktree session's tab is active. */
  get view() {
    const session = this.#sessionId === null ? null : sessionOf(this.#sessionId);
    if (!session?.baseCommit) return null;
    return {
      sessionId: session.id,
      changes: this.#changes,
      expanded: this.#expanded,
      diffs: this.#diffs,
      folder: session.folder,
      base: session.baseCommit,
    };
  }

  /** @param {string | null} sessionId */
  #show(sessionId) {
    if (sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    this.#changes = NOT_LOADED;
    this.#expanded = new Set();
    this.#diffs = new Map();
    this.#loads.clear();
    this.#busy = sessionId !== null && isBusy(sessionOf(sessionId));
    if (sessionId !== null) this.#list();
    this.#host.requestUpdate();
  }

  /** Lists the changed files; the expanded ones still listed are read again. */
  async #list() {
    const id = this.#sessionId;
    if (id === null) return;
    this.#changes = { ...this.#changes, loading: true };
    this.#host.requestUpdate();
    /** @type {GitChangesView} */
    let changes;
    try {
      changes = { files: await sessionChanges(id), loaded: true, loading: false, error: null };
    } catch (err) {
      changes = { files: [], loaded: true, loading: false, error: String(err) };
    }
    if (id !== this.#sessionId) return;
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
    const id = this.#sessionId;
    const session = id === null ? null : sessionOf(id);
    if (id === null || !session) return;
    const load = ++this.#loadCount;
    this.#loads.set(rel, load);
    if (!this.#diffs.has(rel)) this.#setDiff(rel, { content: '', baseline: '', error: '', loading: true });
    const [content, baseline] = await Promise.all([
      readFile(`${session.folder}/${rel}`).catch(() => null),
      sessionFileAtBase(id, rel).catch(() => null),
    ]);
    if (id !== this.#sessionId || this.#loads.get(rel) !== load) return;
    this.#setDiff(
      rel,
      content === null && baseline === null
        ? { content: '', baseline: '', error: `${rel}: neither in the worktree nor at its base`, loading: false }
        : { content: content ?? '', baseline: baseline ?? '', error: '', loading: false },
    );
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
