import { projects } from '../../hooks/projects/projects.js';
import { StoreController } from '../store/StoreController.js';
import { git } from '../../hooks/git/git.js';
import { CHANGES_TAB_ID, $editorTabs } from '../../stores/editor/editor.js';
import { $gitCompare, $gitHead, $shownChanges } from '../../stores/git/git.js';
import { $rootId } from '../../stores/workspaces/workspaces.js';

/** @typedef {import('lit').ReactiveController} ReactiveController */
/** @typedef {import('lit').ReactiveControllerHost} ReactiveControllerHost */
/** @typedef {import('../../hooks/tabs/types.js').FileDiff} FileDiff */
/** @typedef {import('../../hooks/git/types.js').GitChangesView} GitChangesView */
/** @typedef {import('../../hooks/git/types.js').GitFileStatus} GitFileStatus */
/** @typedef {import('../../hooks/git/types.js').RootChanges} RootChanges */

/**
 * Whether two status entries of one file describe the same change.
 * @param {GitFileStatus | undefined} a
 * @param {GitFileStatus | undefined} b
 */
function sameStatus(a, b) {
  return (
    a !== undefined &&
    b !== undefined &&
    a.kind === b.kind &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.origPath === b.origPath &&
    a.added === b.added &&
    a.removed === b.removed
  );
}

/**
 * What a view's expanded files are kept under: its root and whether it compares. The branch isn't in
 * it: going from one branch to another keeps them.
 * @param {string | null} rootId
 * @param {boolean} comparing
 */
const viewKey = (rootId, comparing) => `${comparing ? 'compare' : 'local'}:${rootId}`;

/**
 * The Changes tab's data while the tab is open: which listed files are expanded (per open root and mode) and
 * their diffs, against HEAD or, while comparing to a branch, the comparison's base; read again only
 * when a file changed (on disk, in the status, or HEAD moved). Keeps the changes current while the
 * tab is active. Everything is dropped when it closes.
 * @implements {ReactiveController}
 */
export class ChangesReviewController {
  /** @type {ReactiveControllerHost} */
  #host;
  /** @type {ReadonlySet<string>} Root-relative paths of the files shown with their diff. */
  #expanded = new Set();
  /** @type {ReadonlyMap<string, FileDiff>} */
  #diffs = new Map();
  /** @type {Map<string, GitFileStatus>} The listed files, by root-relative path. */
  #files = new Map();
  /** @type {Set<string>} Expanded files whose diff must be read again, once the status is current. */
  #staleDiffs = new Set();
  /** @type {string | null} Root whose files are expanded and diffed. */
  #shownRoot = null;
  /** @type {Map<string, ReadonlySet<string>>} Expanded files of the views not shown, by `viewKey`. */
  #expandedByView = new Map();
  /** @type {Map<string, number>} Latest diff read per file; an older one that resolves later is dropped. */
  #loads = new Map();
  /** Sequence number handed to each diff/file read. */
  #loadCount = 0;
  /** @type {string | null} The branch the expanded files and diffs are of; `null` for local changes. */
  #target = null;
  /** @type {string | null} The base the diffs are against while comparing. */
  #base = null;
  /** The Changes tab is open. */
  #open = false;
  /** The host is connected. */
  #connected = false;
  /** @type {(() => void) | null} Stops watching; set while the tab is active. */
  #unwatch = null;
  /** @type {StoreController<GitChangesView>} */
  #changes;
  /** @type {StoreController<string | null>} */
  #rootId;

  /** @param {ReactiveControllerHost & HTMLElement} host */
  constructor(host) {
    this.#host = host;
    this.#changes = new StoreController(host, {
      store: $shownChanges,
      onChange: (changes, old) => {
        if (this.#open) this.#onChanges(changes, old);
      },
    });
    // HEAD moved: every diff's baseline is stale; read again with the status refresh that follows.
    // Not when HEAD first becomes known.
    new StoreController(host, {
      store: $gitHead,
      onChange: (_head, old) => {
        if (old == null) return;
        for (const id of this.#expanded) this.#staleDiffs.add(id);
      },
    });
    this.#rootId = new StoreController(host, {
      store: $rootId,
      onChange: () => {
        if (this.#open) this.#followView();
      },
    });
    new StoreController(host, {
      store: $editorTabs,
      onChange: ({ paths, active }) => {
        this.#setOpen(paths.includes(CHANGES_TAB_ID));
        this.#setWatching(active === CHANGES_TAB_ID);
      },
    });
    host.addController(this);
  }

  /** @returns {ReadonlySet<string>} */
  get expanded() {
    return this.#expanded;
  }

  /** @returns {ReadonlyMap<string, FileDiff>} */
  get diffs() {
    return this.#diffs;
  }

  hostConnected() {
    this.#connected = true;
    this.#stopWatching = projects.onFsChange(this.#onFsChange);
    this.#setWatching($editorTabs.get().active === CHANGES_TAB_ID);
  }

  hostDisconnected() {
    this.#connected = false;
    this.#stopWatching();
    this.#setWatching(false);
  }

  /** Stops listening to the files changing on disk. */
  #stopWatching = () => {};

  #onFsChange = (/** @type {RootChanges} */ { added, modified, removed }) => {
    for (const id of [...added, ...modified, ...removed]) {
      if (this.#expanded.has(id)) this.#staleDiffs.add(id);
    }
  };

  /** @param {boolean} watching */
  #setWatching(watching) {
    if (watching && this.#connected) this.#unwatch ??= git.watchChanges();
    else if (!watching) {
      this.#unwatch?.();
      this.#unwatch = null;
    }
  }

  /** @param {boolean} open */
  #setOpen(open) {
    if (open === this.#open) return;
    this.#open = open;
    if (open) {
      this.#onChanges(this.#changes.value, undefined);
      return;
    }
    this.#expanded = new Set();
    this.#diffs = new Map();
    this.#files = new Map();
    this.#staleDiffs.clear();
    this.#expandedByView.clear();
    this.#target = null;
    this.#base = null;
    this.#loads.clear();
    this.#shownRoot = null;
    this.#host.requestUpdate();
  }

  /**
   * New status: a diff is read again only when its file changed. A check that found nothing new
   * keeps the same `files` array.
   * @param {GitChangesView} changes
   * @param {GitChangesView | undefined} old
   */
  #onChanges({ files, loaded, loading }, old) {
    // First: a list arriving with the comparison mustn't be read against the last baseline.
    this.#followView();
    if (files !== old?.files) {
      const previous = this.#files;
      this.#files = new Map(files.map((file) => [file.path, file]));
      if (loaded) {
        const expanded = [...this.#expanded].filter((id) => this.#files.has(id));
        if (expanded.length !== this.#expanded.size) this.#setExpanded(new Set(expanded));
        for (const [id, file] of this.#files) {
          if (this.#expanded.has(id) && !sameStatus(previous.get(id), file)) this.#staleDiffs.add(id);
        }
      }
    }
    if (loaded && !loading) this.#flushStaleDiffs();
  }

  /**
   * Another project or mode brings its own expanded files, another branch or base keeps them. No diff
   * is carried over: diffs are cached by path, paths repeat across projects, and the baseline or the
   * files may have changed. Reads the root and the comparison as they are now, so a project's change
   * is one step whichever of the two is heard first (the git hook writes both on it).
   */
  #followView() {
    const rootId = this.#rootId.value;
    const { target, base } = $gitCompare.get();
    const otherRoot = rootId !== this.#shownRoot;
    if (!otherRoot && target === this.#target && base === this.#base) return;
    const comparing = target !== null;
    const wasComparing = this.#target !== null;
    if (otherRoot || comparing !== wasComparing) {
      // A comparison left for local changes starts over next time; one left for another project is back with it.
      if (otherRoot || comparing) this.#expandedByView.set(viewKey(this.#shownRoot, wasComparing), this.#expanded);
      for (const key of this.#expandedByView.keys()) {
        const root = key.slice(key.indexOf(':') + 1);
        if (!projects.isOpen(root)) this.#expandedByView.delete(key);
      }
      const key = viewKey(rootId, comparing);
      this.#expanded = new Set(this.#expandedByView.get(key));
      this.#expandedByView.delete(key);
    }
    this.#shownRoot = rootId;
    this.#target = target;
    this.#base = base;
    this.#diffs = new Map();
    this.#loads.clear(); // reads still in flight are of the last view
    this.#staleDiffs.clear();
    this.#host.requestUpdate();
  }

  /** Reads the stale diffs again, and those of expanded files never read. */
  #flushStaleDiffs() {
    for (const id of this.#files.keys()) {
      if (!this.#expanded.has(id)) continue;
      if (this.#staleDiffs.has(id) || !this.#diffs.has(id)) this.#loadDiff(id);
    }
    this.#staleDiffs.clear();
  }

  /** @param {ReadonlySet<string>} expanded */
  #setExpanded(expanded) {
    this.#expanded = expanded;
    this.#host.requestUpdate();
  }

  /**
   * Shows a file's diff, reading it if the file is listed.
   * @param {string} id Root-relative path.
   */
  expand(id) {
    if (this.#expanded.has(id)) return;
    this.#setExpanded(new Set([...this.#expanded, id]));
    if (this.#files.has(id)) this.#loadDiff(id);
  }

  /** @param {string} id Root-relative path. */
  toggle(id) {
    if (!this.#expanded.has(id)) {
      this.expand(id);
      return;
    }
    const next = new Set(this.#expanded);
    next.delete(id);
    this.#setExpanded(next);
  }

  /** Collapses every expanded file. */
  collapseAll() {
    this.#setExpanded(new Set());
  }

  /**
   * Reads a file and its baseline for its diff: a deleted file is nothing against the baseline, a
   * new one is the file against nothing.
   * @param {string} id
   */
  async #loadDiff(id) {
    this.#staleDiffs.delete(id);
    const load = ++this.#loadCount;
    this.#loads.set(id, load);
    if (!this.#diffs.has(id)) this.#setDiff(id, { content: '', baseline: '', error: '', loading: true });
    const rootId = projects.rootId();
    const path = projects.absPath(id);
    const file = this.#files.get(id);
    const rel = file?.origPath ?? id;
    const base = !rootId ? Promise.resolve(null) : this.#base ? git.fileAtRev(rootId, this.#base, rel) : git.fileAtHead(rootId, rel);
    const diff = await git.readDiff(projects.readFile(path), base, file?.kind === 'deleted');
    if (this.#loads.get(id) !== load) return;
    this.#setDiff(id, diff);
  }

  /**
   * @param {string} id
   * @param {FileDiff} diff
   */
  #setDiff(id, diff) {
    this.#diffs = new Map(this.#diffs).set(id, diff);
    this.#host.requestUpdate();
  }
}
