import { LitElement, html, nothing } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';
import { projects } from '../../hooks/projects/projects.js';
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, clampSplit } from '../../hooks/markdown/split.js';
import { MarkdownScrollSyncController } from '../../controllers/markdown-scroll-sync/MarkdownScrollSyncController.js';
import '../code-view/code-view.js';
import '../markdown/markdown.js';
import '../markdown-switcher/markdown-switcher.js';
import '../pane/pane.js';
import '../resize-handle/resize-handle.js';
import styles from './markdown-view.css?inline';

/** @typedef {import('../../hooks/markdown/types.js').MarkdownMode} MarkdownMode */
/** @typedef {import('../../hooks/tabs/types.js').EditorTab} EditorTab */
/** @typedef {import('../../hooks/search/types.js').RevealAt} RevealAt */
/** @typedef {import('../../hooks/comments/types.js').AgentThread} AgentThread */
/** @typedef {import('../../hooks/comments/types.js').CommentFocus} CommentFocus */
/** @typedef {import('../../hooks/workspaces/types.js').WorktreeFolder} WorktreeFolder */
/** @typedef {import('../file-tree/file-tree.js').ListDir} ListDir */
/** @typedef {import('../resize-handle/resize-handle.js').ResizeEventDetail} ResizeEventDetail */

/** The preview follows the typing this long after it stops. */
const RENDER_DELAY = 150;
/** A file this long (characters) waits longer, and says so. */
const BIG_FILE = 1_000_000;
const BIG_FILE_DELAY = 500;
/** The name of the divider's resize events. */
const HANDLE = 'markdown';

/**
 * @tag acp-markdown-view
 * @summary A markdown file's tab: a bar with the view switcher over its code editor, a live rendered preview, or both side by side; the editor is hidden in Preview, never removed.
 * @fires acp-markdown-mode `{ id, mode }` A view was picked (or a double-click in Preview asks for Split).
 * @fires acp-markdown-sync `{ on }` The scroll sync was switched.
 * @fires acp-markdown-ratio `{ ratio }` The divider was set: the editor's share, in percent.
 * @fires acp-file-open `{ path }` A link of the preview to a file.
 * @fires acp-file-reveal `{ path, expand }` A link of the preview to a folder.
 * @fires acp-link-open `{ url }` A web link of the preview.
 */
export class AcpMarkdownView extends LitElement {
  static properties = {
    tab: { attribute: false },
    mode: { type: String, reflect: true },
    scrollSync: { attribute: false },
    ratio: { attribute: false },
    language: { attribute: false },
    root: { attribute: false },
    rootId: { attribute: false },
    worktrees: { attribute: false },
    listDir: { attribute: false },
    comments: { attribute: false },
    commentFocus: { attribute: false },
    loadImage: { attribute: false },
  };

  static styles = styles;

  /** @type {string | null} What the preview shows; `null` while it isn't shown. */
  #shown = null;
  /** @type {string | null} The tab it is of. */
  #shownTab = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer;
  /** Waiting to render a big file. */
  #rendering = false;
  /** @type {number | null} The editor's share during a drag. */
  #dragShare = null;
  /** @type {{ start: number, total: number } | null} */
  #drag = null;

  #sync = new MarkdownScrollSyncController(this, {
    editor: () => this.#editorScroller(),
    preview: () => this.renderRoot.querySelector('.acp-markdown-view__scroller'),
    blocks: () => this.#preview?.blocks ?? [],
    enabled: () => this.mode === 'split' && this.scrollSync,
    onCurrent: (node) => this.#preview?.markBlock(node),
  });

  constructor() {
    super();
    /** @type {EditorTab | null} */
    this.tab = null;
    /** @type {MarkdownMode} */
    this.mode = 'raw';
    /** @type {boolean} In Split, the two panes scroll together. */
    this.scrollSync = true;
    /** @type {number} The editor's share of Split, in percent. */
    this.ratio = SPLIT_DEFAULT;
    /** @type {string} */
    this.language = '';
    /** @type {string | null} The project's path. */
    this.root = null;
    /** @type {string | null} */
    this.rootId = null;
    /** @type {readonly WorktreeFolder[]} */
    this.worktrees = [];
    /** @type {ListDir} */
    this.listDir = async () => [];
    /** @type {Readonly<Record<string, readonly AgentThread[]>>} */
    this.comments = {};
    /** @type {CommentFocus | null} */
    this.commentFocus = null;
    /** @type {((path: string) => Promise<Blob>) | null} Reads a local image's bytes. */
    this.loadImage = null;
  }

  get #codeView() {
    return /** @type {import('../code-view/code-view.js').AcpCodeView | null} */ (this.renderRoot.querySelector('acp-code-view'));
  }

  get #preview() {
    return /** @type {import('../markdown/markdown.js').AcpMarkdown | null} */ (this.renderRoot.querySelector('acp-markdown'));
  }

  /** The code editor's scroller, for the scroll sync. */
  #editorScroller() {
    const view = this.#codeView?.renderRoot.querySelector('cdx-code-editor')?.view;
    if (!view) return undefined;
    return {
      dom: view.scrollDOM,
      topLine: () => {
        const top = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
        return view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number;
      },
      scrollToLine: (/** @type {number} */ line) => {
        const doc = view.state.doc;
        const from = doc.line(Math.min(Math.max(1, line), doc.lines)).from;
        view.scrollDOM.scrollTop = view.lineBlockAt(from).top + view.documentPadding.top;
      },
    };
  }

  /** @type {RevealAt | null} Where the editor is to put the caret once it is shown. */
  #pendingAt = null;

  /**
   * Puts the caret on a line of the editor, or selects a range there; in Preview the editor is
   * opened first (as Split).
   * @param {RevealAt} at
   */
  revealLine(at) {
    if (this.mode === 'preview') {
      this.#pendingAt = at;
      this.#emit('acp-markdown-mode', { id: this.tab?.id, mode: 'split' });
      return undefined;
    }
    const code = this.#codeView;
    // Not rendered yet (a tab just opened): once it is.
    return code ? code.revealLine(at) : this.updateComplete.then(() => this.#codeView?.revealLine(at));
  }

  /** The editor's selected text, `''` when none. */
  selectedText() {
    return this.#codeView?.selectedText() ?? '';
  }

  disconnectedCallback() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    // Shown again, the preview starts from the text as it is then.
    this.#shown = null;
    this.#rendering = false;
    super.disconnectedCallback();
  }

  /** @param {EditorTab | null} tab */
  #textOf(tab) {
    return tab?.loaded ? (tab.draft ?? tab.content) : '';
  }

  /**
   * Follows the text: at once the first time and for another file, else a moment after the typing
   * stops. A file of more than a megabyte waits to be rendered either way.
   */
  willUpdate() {
    const tab = this.tab;
    const text = this.#textOf(tab);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#rendering = false;
    if (this.mode === 'raw') {
      this.#shown = null;
      return;
    }
    if (this.#shown === null || (tab?.id ?? null) !== this.#shownTab) {
      this.#shown = text.length > BIG_FILE ? '' : text;
      this.#shownTab = tab?.id ?? null;
    }
    if (text === this.#shown) return;
    const big = text.length > BIG_FILE;
    this.#rendering = big;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#shown = this.#textOf(this.tab);
        this.#rendering = false;
        this.requestUpdate();
      },
      big ? BIG_FILE_DELAY : RENDER_DELAY,
    );
  }

  async firstUpdated() {
    // The editor's view exists a little later: bind the scroll sync once it does.
    await this.#codeView?.updateComplete;
    await this.#codeView?.renderRoot.querySelector('cdx-code-editor')?.updateComplete;
    this.requestUpdate();
  }

  updated() {
    if (this.#pendingAt !== null && this.mode !== 'preview') {
      const at = this.#pendingAt;
      this.#pendingAt = null;
      this.revealLine(at);
    }
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** The switcher: told with the tab it is for. */
  #onSwitcher = (/** @type {Event} */ e) => {
    e.stopPropagation();
    const detail = /** @type {CustomEvent<{ mode?: MarkdownMode, on?: boolean }>} */ (e).detail;
    if (e.type === 'acp-markdown-mode' && detail.mode) this.#emit('acp-markdown-mode', { id: this.tab?.id, mode: detail.mode });
    else if (e.type === 'acp-markdown-sync') this.#emit('acp-markdown-sync', { on: detail.on });
  };

  /** A block double-clicked: its first line in the editor, which a Preview opens (as Split) first. */
  #onBlockActivate = (/** @type {Event} */ e) => {
    e.stopPropagation();
    this.revealLine(/** @type {CustomEvent<{ line: number }>} */ (e).detail.line);
  };

  /**
   * The divider's drag, keys and reset, which move the ratio between the editor and the preview.
   * @param {Event} e
   */
  #onResize = (e) => {
    const { name, delta = 0, measure } = /** @type {CustomEvent<ResizeEventDetail>} */ (e).detail;
    if (name !== HANDLE) return;
    e.stopPropagation();
    const share = () => (this.#drag ? clampSplit(((this.#drag.start + delta) / this.#drag.total) * 100) : this.ratio);
    switch (e.type) {
      case 'acp-resize-start':
        if (measure) this.#drag = { start: measure.width, total: measure.width + measure.neighborWidth };
        break;
      case 'acp-resize':
        this.#dragShare = share();
        this.requestUpdate();
        break;
      case 'acp-resize-end': {
        const ratio = this.#dragShare ?? this.ratio;
        this.#dragShare = null;
        this.#drag = null;
        this.#emit('acp-markdown-ratio', { ratio });
        this.requestUpdate();
        break;
      }
      case 'acp-resize-step':
        if (measure) this.#emit('acp-markdown-ratio', { ratio: clampSplit(((measure.width + delta) / (measure.width + measure.neighborWidth)) * 100) });
        break;
      case 'acp-resize-reset':
        this.#emit('acp-markdown-ratio', { ratio: SPLIT_DEFAULT });
        break;
    }
  };

  /** @param {EditorTab} tab */
  #renderEditor(tab) {
    return html`<acp-code-view
      class="acp-markdown-view__editor"
      .tab=${tab}
      .language=${this.language}
      .root=${this.root}
      .rootId=${this.rootId}
      .worktrees=${this.worktrees}
      .listDir=${this.listDir}
      .comments=${this.comments}
      .commentFocus=${this.commentFocus}
    ></acp-code-view>`;
  }

  /** @param {EditorTab} tab */
  #renderPreview(tab) {
    const slash = tab.path.lastIndexOf('/');
    // A worktree session's file is in its own folder, not the project's.
    const root = projects.worktreeOf(this.worktrees, tab.path)?.folder ?? this.root;
    return html`<div class="acp-markdown-view__scroller">
      <acp-markdown
        class=${classMap({ 'acp-markdown-view__preview': true, 'acp-markdown-view__preview_centered': this.mode === 'preview' })}
        policy="document"
        .baseDir=${tab.path.slice(0, slash === -1 ? 0 : slash)}
        .root=${root}
        .loadImage=${this.loadImage}
        .text=${this.#shown ?? ''}
        @acp-block-activate=${this.#onBlockActivate}
      ></acp-markdown>
    </div>`;
  }

  render() {
    const tab = this.tab;
    if (!tab) return nothing;
    const { mode } = this;
    const share = this.#dragShare ?? this.ratio;
    return html`<div
      class="acp-markdown-view__stage"
      @acp-resize-start=${this.#onResize}
      @acp-resize=${this.#onResize}
      @acp-resize-end=${this.#onResize}
      @acp-resize-step=${this.#onResize}
      @acp-resize-reset=${this.#onResize}
      @acp-markdown-mode=${this.#onSwitcher}
      @acp-markdown-sync=${this.#onSwitcher}
    >
      <div class="acp-markdown-view__bar">
        ${this.#rendering ? html`<span class="acp-markdown-view__rendering" role="status">Rendering…</span>` : nothing}
        <acp-markdown-switcher class="acp-markdown-view__switcher" .mode=${mode} .scrollSync=${this.scrollSync}></acp-markdown-switcher>
      </div>
      <div class="acp-markdown-view__split">
        <acp-pane class="acp-markdown-view__pane" style=${styleMap({ flex: `${share} 1 0` })} ?hidden=${mode === 'preview'}>
          ${this.#renderEditor(tab)}
        </acp-pane>
        ${(['x', 'y']).map(
          (axis) => html`<acp-resize-handle
            class="acp-markdown-view__handle acp-markdown-view__handle_${axis === 'x' ? 'row' : 'column'}"
            name=${HANDLE}
            axis=${axis}
            label="Resize editor and preview"
            .value=${share}
            .min=${SPLIT_MIN}
            .max=${SPLIT_MAX}
            ?hidden=${mode !== 'split'}
          ></acp-resize-handle>`,
        )}
        <acp-pane class="acp-markdown-view__pane" style=${styleMap({ flex: `${100 - share} 1 0` })} ?hidden=${mode === 'raw'}>
          ${mode === 'raw' ? nothing : this.#renderPreview(tab)}
        </acp-pane>
      </div>
    </div>`;
  }
}

customElements.define('acp-markdown-view', AcpMarkdownView);
