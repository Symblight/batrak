import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { EditorView } from '@codemirror/view';
import { defineCdxPlugin } from '@symblight/code-editor';
import '@symblight/wc-material/tabs';
import '@symblight/wc-material/icon';
import '@symblight/wc-material/tooltip';
import { allPreset } from '@symblight/code-editor/presets';
import closeIcon from '@material-design-icons/svg/outlined/close.svg?raw';
import fileIcon from '@material-design-icons/svg/outlined/description.svg?raw';
import { fileIconFor } from '../../models/file-icons.js';
import { readFile } from '../../services/ipc.js';
import { projectController } from '../../services/project-controller.js';
import { StoreController } from '../../controllers/store/StoreController.js';
import { $editorTabs, activateTab, closeTab, openTab } from '../../stores/editor.js';
import { $rootId } from '../../stores/workspace.js';
import styles from './acp-code-editor.css?inline';

/** @typedef {import('../../models/types.js').WorkspaceChanges} WorkspaceChanges */
/** @typedef {import('../../models/types.js').EditorTabs} EditorTabs */

/**
 * An open file; which files are open, and the active one, live in `$editorTabs`.
 * @typedef {Object} EditorTab
 * @property {string} path Absolute.
 * @property {string} content
 * @property {string} error
 * @property {boolean} loaded Whether `content` has been read yet.
 */

/**
 * Compact scrollbars. CodeMirror's scroller sits in the editor's shadow root, out of reach of our CSS,
 * so the rules go in as a theme. WebKit (Tauri on macOS) lacks `scrollbar-color`: it gets the pseudo-elements.
 */
const scrollbarPlugin = defineCdxPlugin({
  id: 'acp-scrollbar',
  extensions: [
    EditorView.theme({
      '@supports (scrollbar-color: auto)': {
        '.cm-scroller': {
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--md-outline-variant) transparent',
        },
      },
      '@supports not (scrollbar-color: auto)': {
        '.cm-scroller::-webkit-scrollbar': { width: '6px', height: '6px' },
        '.cm-scroller::-webkit-scrollbar-track, .cm-scroller::-webkit-scrollbar-corner': {
          background: 'transparent',
        },
        '.cm-scroller::-webkit-scrollbar-thumb': {
          background: 'var(--md-outline-variant)',
          borderRadius: '3px',
        },
      },
    }),
  ],
});
const editorPlugins = [...allPreset, scrollbarPlugin];

/** @param {string} path */
function basename(path) {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * @tag acp-code-editor
 * @summary Open files (`$editorTabs`) as closable tabs, one read-only editor with a status bar per tab.
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
  /** @type {Map<string, number>} Latest read per open file; an older read that resolves later is dropped. */
  #loads = new Map();
  #loadCount = 0;
  /**
   * The backend reads only inside an opened root, so tabs opened without one load once it opens. Only
   * those: on a project switch `#syncTabs` already loads the new project's tabs, in either order.
   * Declared before `#editorTabs`: on connect it runs first, while `tabs` is still empty.
   */
  #rootId = new StoreController(this, {
    store: $rootId,
    onChange: (rootId) => {
      if (rootId === null) return;
      for (const tab of this.tabs) if (!tab.loaded && !this.#loads.has(tab.path)) this.#load(tab.path);
    },
  });
  #editorTabs = new StoreController(this, { store: $editorTabs, onChange: (tabs, old) => this.#syncTabs(tabs, old) });
  #onFsChange = (/** @type {Event} */ e) => {
    const { modified, added, removed } = /** @type {CustomEvent<WorkspaceChanges>} */ (e).detail;
    for (const tab of this.tabs) {
      const rel = projectController.relPath(tab.path);
      if (rel === null) continue;
      // Read-only for now, so there are no local edits to protect: just reload.
      if (modified.includes(rel) || added.includes(rel)) this.#load(tab.path);
      else if (removed.includes(rel)) this.#patch(tab.path, { error: `${tab.path}: deleted on disk` });
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
  get #activePath() {
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
   * Opens a file in a tab (or switches to its tab), optionally with the caret on a line.
   * @param {string} path Absolute.
   * @param {number | null} [line] 1-based.
   */
  show(path, line = null) {
    this.#pendingLine = line;
    const loaded = this.#find(path)?.loaded;
    openTab(path); // a new tab starts loading in #syncTabs and reveals the line once loaded
    if (loaded) this.#revealPendingLine();
  }

  /**
   * Closes a file's tab, activating a neighbour if it was the active one.
   * @param {string} path
   */
  close(path) {
    if (path === this.#activePath) this.#pendingLine = null;
    closeTab(path);
  }

  /**
   * Mirrors `$editorTabs` into `tabs`, keeping loaded content and loading newly opened files.
   * @param {EditorTabs} tabs
   * @param {EditorTabs | undefined} old
   */
  #syncTabs({ paths, active }, old) {
    const known = new Map(this.tabs.map((t) => [t.path, t]));
    this.tabs = paths.map((path) => known.get(path) ?? { path, content: '', error: '', loaded: false });
    for (const path of known.keys()) if (!paths.includes(path)) this.#loads.delete(path);
    if (this.#rootId.value !== null) for (const path of paths) if (!known.has(path)) this.#load(path);
    if (active !== old?.active) this.#activeChanged = true;
  }

  /** @param {string} path */
  #find(path) {
    return this.tabs.find((t) => t.path === path);
  }

  /**
   * @param {string} path
   * @param {Partial<EditorTab>} changes
   */
  #patch(path, changes) {
    this.tabs = this.tabs.map((t) => (t.path === path ? { ...t, ...changes } : t));
  }

  /**
   * Reads a file into its tab; a load error is shown in place of the editor.
   * @param {string} path
   */
  async #load(path) {
    const id = ++this.#loadCount;
    this.#loads.set(path, id);
    /** @type {Partial<EditorTab>} */
    let changes;
    try {
      changes = { content: await readFile(path), error: '' };
    } catch (err) {
      changes = { content: '', error: String(err) };
    }
    if (this.#loads.get(path) !== id) return; // closed, or read again, meanwhile
    this.#patch(path, { ...changes, loaded: true });
    if (path === this.#activePath) this.#revealPendingLine();
  }

  /** Puts the caret on `#pendingLine` in the active tab's editor, once. */
  async #revealPendingLine() {
    const line = this.#pendingLine;
    if (line === null || this.#activePath === null) return;
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
      (t) => t.getAttribute('value') === this.#activePath,
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
   * @param {string} path
   */
  #onCloseClick(e, path) {
    e.stopPropagation(); // don't let the tab activate itself
    this.close(path);
  }

  /**
   * @param {KeyboardEvent} e
   * @param {string} path
   */
  #onCloseKey(e, path) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.#onCloseClick(e, path);
  }

  /** @param {EditorTab} tab */
  #renderTab(tab) {
    const name = basename(tab.path);
    const id = `tab-${tab.path.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    return html`<md-tab id=${id} class="acp-code-editor__tab" value=${tab.path}>
      <md-tooltip for=${id}>${tab.path}</md-tooltip>
      <span class="acp-code-editor__tab-label">
        <md-icon class="acp-code-editor__file-icon">${unsafeSVG(fileIconFor(name) ?? fileIcon)}</md-icon>
        ${name}
        <span
          class="acp-code-editor__close"
          role="button"
          tabindex="0"
          aria-label="Close ${name}"
          title="Close"
          @click=${(/** @type {Event} */ e) => this.#onCloseClick(e, tab.path)}
          @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onCloseKey(e, tab.path)}
          ><md-icon class="acp-code-editor__close-icon">${unsafeSVG(closeIcon)}</md-icon></span
        >
      </span>
    </md-tab>`;
  }

  /** @param {EditorTab} tab */
  #renderPanel(tab) {
    return html`<md-tab-panel
      class="acp-code-editor__panel"
      value=${tab.path}
      ?active=${tab.path === this.#activePath}
    >
      ${tab.error
        ? html`<pre class="acp-code-editor__error">${tab.error}</pre>`
        : html`<cdx-code-editor
            class="acp-code-editor__editor"
            read-only
            .plugins=${editorPlugins}
            filename=${tab.path}
            .value=${tab.content}
          >
            <cdx-footer slot="footer" path=${projectController.relPath(tab.path) ?? tab.path}></cdx-footer>
          </cdx-code-editor>`}
    </md-tab-panel>`;
  }

  render() {
    return html`
      <div class="acp-code-editor__tab-strip" @wheel=${this.#onStripWheel}>
        <md-tabs class="acp-code-editor__tabs" variant="secondary" .value=${this.#activePath ?? ''} @change=${this.#onTabChange}>
          ${repeat(this.tabs, (t) => t.path, (t) => this.#renderTab(t))}
        </md-tabs>
      </div>
      ${repeat(this.tabs, (t) => t.path, (t) => this.#renderPanel(t))}
    `;
  }
}

customElements.define('acp-code-editor', AcpCodeEditor);
