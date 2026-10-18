import { StoreController } from '../store/StoreController.js';
import { readsText } from '../tab-content/TabContentController.js';
import { isUserAgentsFile } from '../../models/agents-file.js';
import { gitFileAtHead, readFile, writeFile } from '../../services/ipc.js';
import { reportError } from '../../services/notices.js';
import { projectController } from '../../services/project-controller.js';
import { $editorTabs, parseTabId } from '../../stores/editor.js';
import { $gitHead } from '../../stores/git.js';
import { $rootId } from '../../stores/workspace.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('../../models/types.js').EditorTab} EditorTab */
/** @typedef {import('../../models/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../../models/types.js').WorkspaceChanges} WorkspaceChanges */

/** @param {string} path */
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * The open tabs (`$editorTabs`) with what they show: reads the active tab's file and its text at HEAD
 * (the diff gutter), re-reads after a change on disk or a HEAD move, keeps an editable file's unsaved
 * draft and saves it. The host renders `tabs`.
 * @implements {ReactiveController}
 */
export class TabFilesController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {EditorTab[]} In `$editorTabs` order. */
  #tabs = [];
  /** @type {Map<string, number>} Latest read per open tab; an older read that resolves later is dropped. */
  #loads = new Map();
  #loadCount = 0;
  /** @type {Set<string>} Open tabs whose read is in flight. */
  #reading = new Set();
  /** @type {Map<string, number>} Latest baseline read per open file tab, like `#loads`. */
  #baselineLoads = new Map();
  /** @type {StoreController<string | null>} */
  #rootId;
  /** @type {StoreController<EditorTabs>} */
  #editorTabs;

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
    host.addController(this);
  }

  /** @returns {readonly EditorTab[]} In `$editorTabs` order. */
  get tabs() {
    return this.#tabs;
  }

  /** @returns {string | null} */
  get #activeId() {
    return this.#editorTabs.value.active;
  }

  hostConnected() {
    projectController.addEventListener('fs-change', this.#onFsChange);
  }

  hostDisconnected() {
    projectController.removeEventListener('fs-change', this.#onFsChange);
  }

  #onFsChange = (/** @type {Event} */ e) => {
    const { modified, added, removed } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    for (const tab of this.#tabs) {
      const rel = projectController.relPath(tab.path);
      if (rel === null) continue;
      if (removed.includes(rel)) this.#patch(tab.id, { error: `${tab.path}: deleted on disk` });
      else if (!readsText(tab) || tab.draft !== null) continue; // keep unsaved edits
      else if (modified.includes(rel) || added.includes(rel)) {
        if (tab.id === this.#activeId) this.#load(tab.id);
        else if (tab.loaded) this.#patch(tab.id, { loaded: false });
      }
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
    if (draft !== tab.draft) this.#patch(id, { draft });
  }

  /** @param {string} id */
  async save(id) {
    const tab = this.#find(id);
    if (!tab || tab.draft === null) return;
    const content = tab.draft;
    try {
      await writeFile(tab.path, content);
      // Edits typed while saving stay a draft.
      const now = this.#find(id);
      if (now) this.#patch(id, { content, draft: now.draft === content ? null : now.draft });
    } catch (err) {
      reportError(`Saving ${basename(tab.path)} failed`, err);
    }
  }

  /**
   * Follows `$editorTabs`, keeping loaded content and loading the active tab if needed.
   * @param {EditorTabs} tabs
   */
  #syncTabs({ paths, active }) {
    const known = new Map(this.#tabs.map((t) => [t.id, t]));
    this.#tabs = paths.map((id) => {
      const existing = known.get(id);
      if (existing) return existing;
      const target = parseTabId(id);
      // A view, or a file shown other than as text (an image), has nothing to read.
      return { id, ...target, content: '', error: '', loaded: !readsText(target), baseline: null, draft: null };
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
    if (this.#rootId.value === null && !(tab && isUserAgentsFile(tab.path))) return;
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
   * Reads a file tab, and separately its baseline; a load error is shown in place of the editor.
   * @param {string} id
   */
  async #load(id) {
    const { path } = parseTabId(id);
    const load = ++this.#loadCount;
    this.#loads.set(id, load);
    this.#reading.add(id);
    this.#loadBaseline(id);
    /** @type {Partial<EditorTab>} */
    let changes;
    try {
      changes = { content: await readFile(path), error: '' };
    } catch (err) {
      changes = { content: '', error: String(err) };
    }
    if (this.#loads.get(id) !== load) return; // closed, or read again, meanwhile
    this.#reading.delete(id);
    this.#patch(id, { ...changes, loaded: true });
  }

  /**
   * A file's text at HEAD; `null` when it has none or on any failure.
   * @param {string} path Absolute.
   * @returns {Promise<string | null>}
   */
  async #readBaseline(path) {
    const rootId = this.#rootId.value;
    const rel = projectController.relPath(path);
    if (rootId === null || rel === null) return null;
    return gitFileAtHead(rootId, rel).catch(() => null);
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
