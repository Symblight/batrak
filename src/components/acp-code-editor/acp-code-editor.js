import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import '@symblight/code-editor';
import '@symblight/wc-material/tabs';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import differenceIcon from '@material-design-icons/svg/outlined/difference.svg?raw';
import settingsIcon from '@material-design-icons/svg/outlined/settings.svg?raw';
import { commentAuthor, editorPlugins } from '../../models/editor-plugins.js';
import { fileIconFor } from '../../models/file-icons.js';
import { fontStack } from '../../models/editor-fonts.js';
import '../acp-settings/acp-settings.js';
import '../acp-changes-review/acp-changes-review.js';
import { gitFileAtHead, readFile } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $editorTabs, activateTab, closeTab, openTab, parseTabId } from '../../stores/editor.js';
import { $rootId } from '../../stores/workspace.js';
import { $gitHead } from '../../stores/git.js';
import { $editorFont, $editorFontSize, lineHeightFor } from '../../stores/settings.js';
import styles from './acp-code-editor.css?inline';

/** @typedef {import('../../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../../models/types.js').EditorTabs} EditorTabs */
/** @typedef {import('../../models/types.js').TabKind} TabKind */

/**
 * An open tab; which tabs are open, and the active one, live in `$editorTabs`.
 * @typedef {Object} EditorTab
 * @property {string} id Its id in `$editorTabs`.
 * @property {TabKind} kind
 * @property {string} path The file, absolute; `''` for a view (Settings, Changes).
 * @property {string} content
 * @property {string} error
 * @property {boolean} loaded Whether `content` and `baseline` are current. Only the active tab is read;
 *   the others are read, or re-read after a change on disk, when they become active.
 * @property {string | null} baseline The file at HEAD, for the diff gutter; `null` when it has none.
 */

/** @param {string} path */
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * @tag acp-code-editor
 * @summary The main column's tabs (`$editorTabs`): files in read-only editors, and views (Settings, Changes).
 */
export class AcpCodeEditor extends LitElement {
  static properties = {
    tabs: { state: true },
  };

  static styles = styles;

  /** @type {number | null} Line to reveal in the active tab once loaded (1-based). */
  #pendingLine = null;
  /** Set when the active tab changes; `updated()` scrolls it into view. */
  #activeChanged = false;
  /** @type {Map<string, number>} Latest read per open tab; an older read that resolves later is dropped. */
  #loads = new Map();
  #loadCount = 0;
  /** @type {Set<string>} Open tabs whose read is in flight. */
  #reading = new Set();
  /**
   * The backend reads only inside an opened root, so the active tab loads once it opens.
   * Declared before `#editorTabs`: on connect it runs first, while `tabs` is still empty.
   */
  #rootId = new StoreController(this, {
    store: $rootId,
    onChange: (rootId) => {
      if (rootId !== null) this.#ensureLoaded(this.#activeId);
    },
  });
  #editorTabs = new StoreController(this, { store: $editorTabs, onChange: (tabs, old) => this.#syncTabs(tabs, old) });
  /** @type {Map<string, number>} Latest baseline read per open file tab, like `#loads`. */
  #baselineLoads = new Map();
  /**
   * A commit or checkout moves HEAD: every open tab's baseline is stale. The active tab re-reads it,
   * the others when activated. Not when HEAD first becomes known (`old` null, e.g. a root just
   * opened): `#load` read the active baseline already.
   */
  #gitHead = new StoreController(this, {
    store: $gitHead,
    onChange: (_head, old) => {
      if (old == null) return;
      for (const tab of this.tabs) {
        if (tab.kind !== 'file') continue;
        if (tab.id === this.#activeId) this.#loadBaseline(tab.id);
        else if (tab.loaded) this.#patch(tab.id, { loaded: false });
      }
    },
  });
  #editorFont = new StoreController(this, { store: $editorFont });
  #editorFontSize = new StoreController(this, { store: $editorFontSize });
  #onFsChange = (/** @type {Event} */ e) => {
    const { modified, added, removed } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    for (const tab of this.tabs) {
      const rel = projectController.relPath(tab.path);
      if (rel === null) continue;
      // Read-only for now, so there are no local edits to protect: just reload.
      if (removed.includes(rel)) this.#patch(tab.id, { error: `${tab.path}: deleted on disk` });
      else if (modified.includes(rel) || added.includes(rel)) {
        if (tab.id === this.#activeId) this.#load(tab.id);
        else if (tab.loaded) this.#patch(tab.id, { loaded: false });
      }
    }
  };
  /** A plain mouse wheel only scrolls vertically; turn that into scrolling the tab strip. */
  #onStripWheel = (/** @type {WheelEvent} */ e) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const strip = /** @type {HTMLElement} */ (e.currentTarget);
    if (strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  };

  constructor() {
    super();
    /** @type {EditorTab[]} In `$editorTabs` order. */
    this.tabs = [];
  }

  /** @returns {string | null} */
  get #activeId() {
    return this.#editorTabs.value.active;
  }

  connectedCallback() {
    super.connectedCallback();
    projectController.addEventListener('fs-change', this.#onFsChange);
  }

  disconnectedCallback() {
    projectController.removeEventListener('fs-change', this.#onFsChange);
    super.disconnectedCallback();
  }

  /**
   * Opens a tab (or switches to it), optionally with the caret on a line.
   * @param {string} id A file's absolute path, or `diffTabId()` of one for its changes.
   * @param {number | null} [line] 1-based.
   */
  show(id, line = null) {
    this.#pendingLine = line;
    const loaded = this.#find(id)?.loaded;
    openTab(id); // a new tab starts loading in #syncTabs and reveals the line once loaded
    if (loaded) this.#revealPendingLine();
  }

  /**
   * Expands a changed file in the Changes tab and scrolls to it; the tab must be open.
   * @param {string} path Absolute.
   */
  async revealChange(path) {
    await this.updateComplete;
    const rel = projectController.relPath(path);
    if (rel !== null) this.renderRoot.querySelector('acp-changes-review')?.reveal(rel);
  }

  /**
   * Closes a tab, activating a neighbour if it was the active one.
   * @param {string} id
   */
  close(id) {
    if (id === this.#activeId) this.#pendingLine = null;
    closeTab(id);
  }

  /**
   * Mirrors `$editorTabs` into `tabs`, keeping loaded content and loading the active tab if needed.
   * @param {EditorTabs} tabs
   * @param {EditorTabs | undefined} old
   */
  #syncTabs({ paths, active }, old) {
    const known = new Map(this.tabs.map((t) => [t.id, t]));
    this.tabs = paths.map((id) => {
      const existing = known.get(id);
      if (existing) return existing;
      const target = parseTabId(id);
      // A view has nothing to read.
      return { id, ...target, content: '', error: '', loaded: target.kind !== 'file', baseline: null };
    });
    for (const id of known.keys()) {
      if (paths.includes(id)) continue;
      this.#loads.delete(id);
      this.#baselineLoads.delete(id);
      this.#reading.delete(id);
    }
    this.#ensureLoaded(active);
    if (active !== old?.active) this.#activeChanged = true;
  }

  /**
   * Reads a tab that isn't current yet, unless a read is already in flight.
   * @param {string | null} id
   */
  #ensureLoaded(id) {
    if (id === null || this.#rootId.value === null || this.#reading.has(id)) return;
    const tab = this.#find(id);
    if (tab && !tab.loaded) this.#load(id);
  }

  /** @param {string} id */
  #find(id) {
    return this.tabs.find((t) => t.id === id);
  }

  /**
   * @param {string} id
   * @param {Partial<EditorTab>} changes
   */
  #patch(id, changes) {
    this.tabs = this.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t));
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
    if (id === this.#activeId) this.#revealPendingLine();
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

  /** Puts the caret on `#pendingLine` in the active tab's editor, once. */
  async #revealPendingLine() {
    const line = this.#pendingLine;
    if (line === null || this.#activeId === null) return;
    this.#pendingLine = null;
    await this.updateComplete;
    const editor = this.renderRoot
      .querySelector('.acp-code-editor__panel[active]')
      ?.querySelector('cdx-code-editor');
    if (!editor) return;
    await editor.updateComplete;
    editor.navigation.goToLine(line);
    editor.focus();
  }

  updated() {
    if (!this.#activeChanged) return;
    this.#activeChanged = false;
    this.#revealActiveTab();
  }

  /** Scrolls the tab strip so the active tab is fully visible. */
  #revealActiveTab() {
    const tab = [...this.renderRoot.querySelectorAll('md-tab')].find(
      (t) => t.getAttribute('value') === this.#activeId,
    );
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** @param {Event} e */
  #onTabChange(e) {
    this.#pendingLine = null;
    activateTab(/** @type {CustomEvent<{ value: string }>} */ (e).detail.value);
  }

  /**
   * @param {Event} e
   * @param {string} id
   */
  #onCloseClick(e, id) {
    e.stopPropagation(); // don't let the tab activate itself
    this.close(id);
  }

  /**
   * @param {KeyboardEvent} e
   * @param {string} id
   */
  #onCloseKey(e, id) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.#onCloseClick(e, id);
  }

  /**
   * Title, icon and tooltip of a tab.
   * @param {EditorTab} tab
   * @returns {{ title: string, icon: string, tooltip: string }}
   */
  #describe(tab) {
    if (tab.kind === 'settings') return { title: 'Settings', icon: settingsIcon, tooltip: 'Settings' };
    if (tab.kind === 'changes') {
      return { title: 'Changes', icon: differenceIcon, tooltip: 'Changed files and their diffs against HEAD' };
    }
    const name = basename(tab.path);
    return { title: name, icon: fileIconFor(name) ?? fileIcon, tooltip: tab.path };
  }

  /** @param {EditorTab} tab */
  #renderTab(tab) {
    const { title, icon, tooltip } = this.#describe(tab);
    const id = `tab-${tab.id.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    return html`<md-tab id=${id} class="acp-code-editor__tab" value=${tab.id}>
      <md-tooltip for=${id}>${tooltip}</md-tooltip>
      <span class="acp-code-editor__tab-label">
        <md-icon class="acp-code-editor__file-icon">${unsafeSVG(icon)}</md-icon>
        ${title}
        <span
          class="acp-code-editor__close"
          role="button"
          tabindex="0"
          aria-label="Close ${title}"
          title="Close"
          @click=${(/** @type {Event} */ e) => this.#onCloseClick(e, tab.id)}
          @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onCloseKey(e, tab.id)}
          ><md-icon class="acp-code-editor__close-icon">${unsafeSVG(closeIcon)}</md-icon></span
        >
      </span>
    </md-tab>`;
  }

  /** Font settings for file tabs only; views keep the library defaults. */
  #editorStyle() {
    const font = this.#editorFont.value;
    const size = this.#editorFontSize.value;
    return styleMap({
      '--cdx-code-editor-mono-font-family': font ? fontStack(font) : null,
      '--cdx-code-editor-code-font-size': `${size}px`,
      '--cdx-code-editor-code-line-height': `${lineHeightFor(size)}px`,
    });
  }

  /** @param {EditorTab} tab */
  #renderContent(tab) {
    if (tab.kind === 'settings') return html`<acp-settings class="acp-code-editor__view"></acp-settings>`;
    if (tab.kind === 'changes') {
      return html`<acp-changes-review
        class="acp-code-editor__view"
        .active=${tab.id === this.#activeId}
      ></acp-changes-review>`;
    }
    return tab.error
        ? html`<pre class="acp-code-editor__error">${tab.error}</pre>`
        : html`<cdx-code-editor
            class="acp-code-editor__editor"
            style=${this.#editorStyle()}
            read-only
            .plugins=${editorPlugins}
            filename=${tab.path}
            .value=${tab.content}
            .baseline=${tab.baseline}
          >
            <cdx-diff slot="diff" kind="baseline"></cdx-diff>
            <cdx-comments slot="comments" mode="single" .author=${commentAuthor}></cdx-comments>
            <cdx-comments-bar slot="comments-bar"></cdx-comments-bar>
            <cdx-footer slot="footer" path=${projectController.relPath(tab.path) ?? tab.path}></cdx-footer>
          </cdx-code-editor>`;
  }

  /** @param {EditorTab} tab */
  #renderPanel(tab) {
    return html`<md-tab-panel class="acp-code-editor__panel" value=${tab.id} ?active=${tab.id === this.#activeId}>
      ${this.#renderContent(tab)}
    </md-tab-panel>`;
  }

  render() {
    return html`
      <div class="acp-code-editor__tab-strip" @wheel=${this.#onStripWheel}>
        <md-tabs class="acp-code-editor__tabs" variant="secondary" .value=${this.#activeId ?? ''} @change=${this.#onTabChange}>
          ${repeat(this.tabs, (t) => t.id, (t) => this.#renderTab(t))}
        </md-tabs>
      </div>
      ${repeat(this.tabs, (t) => t.id, (t) => this.#renderPanel(t))}
    `;
  }
}

customElements.define('acp-code-editor', AcpCodeEditor);
