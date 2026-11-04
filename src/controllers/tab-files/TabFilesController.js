import { projects } from '../../hooks/projects/projects.js';
import { app } from '../../hooks/app/app.js';
import { StoreController } from '../store/StoreController.js';
import { contentKindOf, readsFile, readsText } from '../tab-content/TabContentController.js';
import { agents } from '../../hooks/agents/agents.js';
import { imageType } from '../../components/image-preview/image-type.js';
import { git } from '../../hooks/git/git.js';
import { $editorTabs, $folderTabs, parseTabId } from '../../stores/editor/editor.js';
import { $gitHead } from '../../stores/git/git.js';
import { $sessions } from '../../stores/sessions/sessions.js';
import { $rootId } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/tabs/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../../hooks/git/types.js').RootChanges} RootChanges */
/** @typedef {import('../../hooks/sessions/types.js').Session} Session */

/**
 * The open tabs (`$editorTabs`) with what they show: reads the active tab's file and its text at HEAD
 * (the diff gutter), or an image tab's bytes, re-reads after a change on disk or a HEAD move, keeps an editable file's unsaved
 * draft (also while another project is shown) and saves it, unless the file changed on disk since
 * (`changedOnDisk`). The host renders `tabs`.
 * @implements {ReactiveController}
 */
export class TabFilesController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {EditorTab[]} In `$editorTabs` order. */
  #tabs = [];
  /** @type {Map<string, number>} Latest read per open tab; an older read that resolves later is dropped. */
  #loads = new Map();
  /** Sequence number handed to each diff/file read. */
  #loadCount = 0;
  /** @type {Set<string>} Open tabs whose read is in flight. */
  #reading = new Set();
  /** @type {Map<string, number>} Latest baseline read per open file tab, like `#loads`. */
  #baselineLoads = new Map();
  /** @type {StoreController<string | null>} */
  #rootId;
  /** @type {StoreController<EditorTabs>} */
  #editorTabs;
  /** @type {Set<string>} Worktree sessions whose agent is mid-turn. */
  #busyWorktrees = new Set();
  /** @type {Map<string, EditorTab>} Tabs with unsaved edits of projects not shown now, by id. */
  #away = new Map();

  /** @param {ReactiveControllerHost & HTMLElement} host */
  constructor(host) {
    this.#host = host;
    // The backend reads only inside an opened root, so the active tab loads once it opens. Created
    // before `#editorTabs`: on connect it runs first, while `#tabs` is still empty.
    this.#rootId = new StoreController(host, {
      store: $rootId,
      onChange: (rootId) => {
        if (rootId !== null) this.#ensureLoaded(this.#activeId);
      },
    });
    this.#editorTabs = new StoreController(host, {
      store: $editorTabs,
      onChange: (tabs) => this.#syncTabs(tabs),
    });
    // A commit or checkout moves HEAD: every open tab's baseline is stale. The active tab re-reads it,
    // the others when activated. Not when HEAD first becomes known (`old` null, e.g. a root just
    // opened): `#load` read the active baseline already.
    new StoreController(host, {
      store: $gitHead,
      onChange: (_head, old) => {
        if (old == null) return;
        for (const tab of this.#tabs) {
          if (!readsText(tab)) continue;
          if (tab.id === this.#activeId) this.#loadBaseline(tab.id);
          else if (tab.loaded) this.#patch(tab.id, { loaded: false });
        }
      },
    });
    // Nothing watches a worktree: its files are re-read when its session's turn ends.
    new StoreController(host, {
      store: $sessions,
      onChange: (sessions) => {
        for (const session of sessions) this.#followWorktree(session);
      },
    });
    host.addController(this);
  }

  /**
   * A worktree session that stopped working may have changed its files: the active tab re-reads
   * one, the others when activated.
   * @param {Session} session
   */
  #followWorktree(session) {
    if (!session.workspaceId) return;
    const busy = session.status === 'working' || session.status === 'waiting';
    if (busy) {
      this.#busyWorktrees.add(session.id);
      return;
    }
    if (!this.#busyWorktrees.delete(session.id)) return;
    for (const tab of this.#tabs) {
      if (!tab.path.startsWith(`${session.folder}/`) || !readsFile(tab) || tab.draft !== null) continue;
      if (tab.id === this.#activeId) this.#load(tab.id);
      else if (tab.loaded) this.#patch(tab.id, { loaded: false });
    }
  }

  /** @returns {readonly EditorTab[]} In `$editorTabs` order. */
  get tabs() {
    return this.#tabs;
  }

  /** @returns {string | null} */
  get #activeId() {
    return this.#editorTabs.value.active;
  }

  /** Stops listening to the files changing on disk. */
  #stopWatching = () => {};

  hostConnected() {
    this.#stopWatching = projects.onFsChange(this.#onFsChange);
  }

  hostDisconnected() {
    this.#stopWatching();
  }

  #onFsChange = (/** @type {RootChanges} */ { modified, added, removed }) => {
    for (const tab of this.#tabs) {
      const rel = projects.relPath(tab.path);
      if (rel === null) continue;
      if (removed.includes(rel)) {
        // A shown text stays, like the edits on it; anything else has nothing left to show.
        if (readsText(tab) && tab.loaded && !tab.error) this.#patch(tab.id, { deletedOnDisk: true, changedOnDisk: false });
        else this.#patch(tab.id, { error: `${tab.path}: deleted on disk` });
      } else if (!readsFile(tab) || !(modified.includes(rel) || added.includes(rel))) continue;
      // Unsaved edits are kept; a save then asks.
      else if (tab.draft !== null) {
        if (tab.deletedOnDisk) this.#patch(tab.id, { deletedOnDisk: false });
        this.#checkDisk(tab.id);
      } else if (tab.id === this.#activeId) this.#load(tab.id);
      else if (tab.loaded) this.#patch(tab.id, { loaded: false });
    }
  };

  /**
   * An edit in an editable file: kept as the tab's draft until saved.
   * @param {string} id
   * @param {string} value The editor's text.
   */
  edit(id, value) {
    const tab = this.#find(id);
    if (!tab) return;
    const draft = value === tab.content ? null : value;
    if (draft === tab.draft) return;
    // Back to the text it started from, which is no longer the file's: show the file.
    if (draft === null && tab.changedOnDisk) this.reload(id);
    else this.#patch(id, { draft });
  }

  /**
   * Writes an edited tab's draft to its file, or a deleted file's text to create it again. Unless
   * `force`, refused when the file changed on disk since the draft started (checked again now: the
   * watcher may not have reported it yet).
   * @param {string} id
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<boolean>} `false` when it was refused for that; nothing was written.
   */
  async save(id, { force = false } = {}) {
    const tab = this.#find(id);
    if (!tab || (tab.draft === null && !tab.deletedOnDisk)) return true;
    if (!force && !tab.deletedOnDisk && (tab.changedOnDisk || (await this.#diskDiffers(tab)))) {
      const now = this.#find(id);
      // Saved meanwhile (another save, or a reload): the disk was checked against old text.
      if (now && now.content !== tab.content) return this.save(id);
      if (now?.changedOnDisk === false) this.#patch(id, { changedOnDisk: true });
      return false;
    }
    const content = tab.draft ?? tab.content;
    try {
      await projects.writeFile(tab.path, content);
      // Edits typed while saving stay a draft.
      const now = this.#find(id);
      if (now) this.#patch(id, { content, draft: now.draft === content ? null : now.draft, changedOnDisk: false, deletedOnDisk: false });
    } catch (err) {
      app.reportError(`Saving ${projects.basename(tab.path)} failed`, err);
    }
    return true;
  }

  /**
   * Drops a tab's edits and shows its file as it is on disk.
   * @param {string} id
   */
  reload(id) {
    if (!this.#find(id)) return;
    this.#patch(id, { draft: null, changedOnDisk: false, deletedOnDisk: false, loaded: false });
    if (id === this.#activeId) this.#load(id);
  }

  /**
   * An edited tab's file changed on disk: marked unless it's still the text the draft started from
   * (the tab's own save, or a write of the same text).
   * @param {string} id
   */
  async #checkDisk(id) {
    const tab = this.#find(id);
    if (!tab || tab.changedOnDisk || !(await this.#diskDiffers(tab))) return;
    const now = this.#find(id);
    // Saved or reloaded meanwhile: `content` is what's on disk now.
    if (now && now.draft !== null && now.content === tab.content) this.#patch(id, { changedOnDisk: true });
  }

  /**
   * Whether the file on disk is no longer the text `tab`'s draft started from; a failed read
   * (not text any more, unreadable, gone) counts as so.
   * @param {EditorTab} tab
   */
  async #diskDiffers(tab) {
    try {
      return (await projects.readFile(tab.path)) !== tab.content;
    } catch {
      return true;
    }
  }

  /**
   * Follows `$editorTabs`, keeping loaded content and loading the active tab if needed.
   * @param {EditorTabs} tabs
   */
  #syncTabs({ paths, active }) {
    const known = new Map(this.#tabs.map((t) => [t.id, t]));
    const open = new Set(Object.values($folderTabs.get()).flatMap((tabs) => tabs?.paths ?? []));
    // Gone from the strip but still open in another project: shown again when that project is.
    for (const tab of this.#tabs) {
      if (tab.draft !== null && !paths.includes(tab.id) && open.has(tab.id)) this.#away.set(tab.id, tab);
    }
    for (const id of this.#away.keys()) {
      if (!open.has(id)) this.#away.delete(id);
    }
    this.#tabs = paths.map((id) => {
      const existing = known.get(id);
      if (existing) return existing;
      const kept = this.#away.get(id);
      if (kept) {
        this.#away.delete(id);
        // Read again on show; `#load` keeps the draft and marks a file that changed meanwhile.
        return { ...kept, loaded: false };
      }
      const target = parseTabId(id);
      // A view has nothing to read.
      const loaded = !readsFile(target);
      return { id, ...target, content: '', error: '', loaded, baseline: null, draft: null, changedOnDisk: false, deletedOnDisk: false, image: null };
    });
    for (const id of known.keys()) {
      if (paths.includes(id)) continue;
      this.#loads.delete(id);
      this.#baselineLoads.delete(id);
      this.#reading.delete(id);
    }
    this.#ensureLoaded(active);
  }

  /**
   * Reads a tab that isn't current yet, unless a read is already in flight.
   * @param {string | null} id
   */
  #ensureLoaded(id) {
    if (id === null || this.#reading.has(id)) return;
    const tab = this.#find(id);
    // The user's agents.json lies outside every root: it reads with no project open.
    if (this.#rootId.value === null && !(tab && agents.isUserAgentsFile(tab.path))) return;
    if (tab && !tab.loaded) this.#load(id);
  }

  /** @param {string} id */
  #find(id) {
    return this.#tabs.find((t) => t.id === id);
  }

  /**
   * @param {string} id
   * @param {Partial<EditorTab>} changes
   */
  #patch(id, changes) {
    this.#tabs = this.#tabs.map((t) => (t.id === id ? { ...t, ...changes } : t));
    this.#host.requestUpdate();
  }

  /**
   * Reads a file tab, and separately its baseline (an image tab: its bytes, no baseline); a load error
   * is shown in place of the view.
   * @param {string} id
   */
  async #load(id) {
    const target = parseTabId(id);
    const { path } = target;
    const image = contentKindOf(target) === 'image';
    const load = ++this.#loadCount;
    this.#loads.set(id, load);
    this.#reading.add(id);
    if (!image) this.#loadBaseline(id);
    /** @type {Partial<EditorTab>} */
    let changes;
    try {
      changes = image
        ? { image: new Blob([await projects.readFileBytes(path)], { type: imageType.of(path).mime }), error: '', deletedOnDisk: false }
        : { content: await projects.readFile(path), error: '', deletedOnDisk: false };
    } catch (err) {
      changes = { content: '', image: null, error: String(err) };
    }
    if (this.#loads.get(id) !== load) return; // closed, or read again, meanwhile
    this.#reading.delete(id);
    const tab = this.#find(id);
    // Edited meanwhile (typed during a reload, or a re-read after a HEAD move): `content` stays the
    // text the draft started from, so a save over a different file still asks.
    if (tab && tab.draft !== null && changes.content !== undefined && !changes.error) {
      const { content, ...rest } = changes;
      changes = content === tab.content ? rest : { ...rest, changedOnDisk: true };
    }
    this.#patch(id, { ...changes, loaded: true });
  }

  /**
   * A file's text at HEAD; `null` when it has none or on any failure.
   * @param {string} path Absolute.
   * @returns {Promise<string | null>}
   */
  async #readBaseline(path) {
    const rootId = this.#rootId.value;
    const rel = projects.relPath(path);
    if (rootId === null || rel === null) return null;
    return git.fileAtHead(rootId, rel).catch(() => null);
  }

  /**
   * Reads a file tab's text at HEAD, for its diff gutter; no baseline (no marks) on any failure.
   * @param {string} id
   */
  async #loadBaseline(id) {
    const load = ++this.#loadCount;
    this.#baselineLoads.set(id, load);
    const baseline = await this.#readBaseline(parseTabId(id).path);
    if (this.#baselineLoads.get(id) !== load) return; // closed, or read again, meanwhile
    if (this.#find(id)?.baseline !== baseline) this.#patch(id, { baseline });
  }
}
